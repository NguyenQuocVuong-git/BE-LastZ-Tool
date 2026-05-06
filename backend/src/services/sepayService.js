import { pool } from '../config/database.js';
import * as userService from './userService.js';
import * as couponService from './couponService.js';
import { notifyActivated } from './telegramService.js';

const IS_PRODUCTION = process.env.IS_PRODUCTION === 'true';

function extractTransactionId(payload) {
  // SePay Webhook: `id`
  // BankHub IPN: `transaction_id`
  return String(payload.transaction_id ?? payload.id ?? '');
}

function extractTransferCode(payload) {
  return (
    payload.code || // Payment code detected via Payment Code Structure (can be null)
    payload.transfer_code ||
    payload.transferContent ||
    payload.description ||
    payload.content || // Transfer description (fallback)
    payload.memo ||
    ''
  );
}

function extractAmount(payload) {
  return Number(
    payload.amount ??
      payload.transferAmount ??
      payload.transfer_amount ??
      payload.transfer_amount_in ??
      0,
  );
}

export function verifySePayWebhook(req) {
  if (!IS_PRODUCTION) {
    console.log('[SANDBOX] Bỏ qua verify SePay apikey');
    return true;
  }
  const rawAuth = req.headers['authorization'];
  if (!rawAuth) return false;

  const s = String(rawAuth).trim();
  const m = s.match(/^Apikey\s+(.+)$/i);
  if (!m) return false;
  return m[1] === process.env.SEPAY_API_KEY;
}

export async function processWebhook(payload) {
  if (!IS_PRODUCTION) {
    console.log('[SANDBOX] SePay webhook payload:', JSON.stringify(payload, null, 2));
  }

  const transactionId = extractTransactionId(payload);
  const transferCode = extractTransferCode(payload);
  const amount = extractAmount(payload);

  if (!transactionId) {
    console.warn('[SePay] Thiếu transaction_id trong payload, bỏ qua.');
    return;
  }

  const existing = await pool.query(
    `SELECT id FROM sepay_transactions WHERE transaction_id = $1`,
    [transactionId],
  );
  if (existing.rowCount > 0) {
    console.log('[SePay] Đã xử lý transaction_id, bỏ qua:', transactionId);
    return;
  }

  if (!transferCode) {
    await pool.query(
      `INSERT INTO sepay_transactions
        (transaction_id, transfer_code, amount, payment_id, matched, raw_payload)
       VALUES ($1, NULL, $2, NULL, false, $3::jsonb)`,
      [transactionId, amount || null, JSON.stringify(payload)],
    );
    console.warn('[SePay] Không lấy được transfer_code (content/code), bỏ qua.');
    return;
  }

  const { rows: payRows } = await pool.query(
    `SELECT pp.*, u.email, p.name AS plan_name,
            dc.code as coupon_code, dc.discount_pct
     FROM pending_payments pp
     JOIN users u ON u.id = pp.user_id
     JOIN plans p ON p.id = pp.plan_id
     LEFT JOIN discount_codes dc ON dc.id = pp.discount_code_id
     WHERE pp.transfer_code = $1 AND pp.status = 'waiting'`,
    [transferCode],
  );
  const payment = payRows[0];

  if (!payment) {
    await pool.query(
      `INSERT INTO sepay_transactions
        (transaction_id, transfer_code, amount, payment_id, matched, raw_payload)
       VALUES ($1, $2, $3, NULL, false, $4::jsonb)`,
      [transactionId, transferCode || null, amount || null, JSON.stringify(payload)],
    );
    console.warn('[SePay] Không tìm thấy pending_payment cho transfer_code:', transferCode);
    return;
  }

  const finalAmount = Number(payment.final_amount);
  const amountNum = Number(amount);
  if (Number.isFinite(finalAmount) && Number.isFinite(amountNum) && amountNum < finalAmount) {
    await pool.query(
      `INSERT INTO sepay_transactions
        (transaction_id, transfer_code, amount, payment_id, matched, raw_payload)
       VALUES ($1, $2, $3, $4, false, $5::jsonb)`,
      [transactionId, transferCode || null, amountNum || null, payment.id, JSON.stringify(payload)],
    );
    console.warn(
      '[SePay] Số tiền chuyển thấp hơn final_amount, bỏ qua. amount=%s, final_amount=%s',
      amountNum,
      finalAmount,
    );
    return;
  }

  await pool.query(
    `INSERT INTO sepay_transactions
      (transaction_id, transfer_code, amount, payment_id, matched, raw_payload)
     VALUES ($1, $2, $3, $4, true, $5::jsonb)`,
    [transactionId, transferCode || null, amountNum || null, payment.id, JSON.stringify(payload)],
  );

  const activateResult = await userService.activateUser({
    userId: payment.user_id,
    planId: payment.plan_id,
    activatedBy: 'sepay',
    note: `payment ${payment.id}`,
  });

  if (!activateResult.ok) {
    console.error('[SePay] activateUser thất bại:', activateResult.message);
    return;
  }

  if (payment.discount_code_id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const inc = await couponService.atomicIncrementCouponUse(client, payment.discount_code_id);
      if (inc) {
        await couponService.insertDiscountUsage(client, {
          discountCodeId: payment.discount_code_id,
          userId: payment.user_id,
          paymentId: payment.id,
          original_amount: payment.amount,
          discount_amount: payment.discount_amount,
          final_amount: payment.final_amount,
        });
      } else {
        console.warn(
          '[SePay] Mã giảm giá vừa hết lượt khi xử lý payment, cần kiểm tra thủ công. discount_code_id=',
          payment.discount_code_id,
        );
      }

      await client.query(
        `UPDATE pending_payments
         SET status = 'confirmed', confirmed_at = NOW()
         WHERE id = $1`,
        [payment.id],
      );

      await client.query(
        `INSERT INTO admin_logs (action, target_id, detail)
         VALUES ($1, $2, $3)`,
        [
          'payment_confirm',
          payment.user_id,
          JSON.stringify({
            payment_id: payment.id,
            via: 'sepay',
            expires_at: activateResult.expires_at.toISOString(),
          }),
        ],
      );

      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      console.error('[SePay] Lỗi khi cập nhật coupon / pending_payments:', e);
      return;
    } finally {
      client.release();
    }
  } else {
    await pool.query(
      `UPDATE pending_payments
       SET status = 'confirmed', confirmed_at = NOW()
       WHERE id = $1`,
      [payment.id],
    );
    await pool.query(
      `INSERT INTO admin_logs (action, target_id, detail)
       VALUES ($1, $2, $3)`,
      [
        'payment_confirm',
        payment.user_id,
        JSON.stringify({
          payment_id: payment.id,
          via: 'sepay',
          expires_at: activateResult.expires_at.toISOString(),
        }),
      ],
    );
  }

  const userForNotify = {
    email: payment.email,
    expires_at: activateResult.expires_at,
  };
  const planForNotify = {
    name: payment.plan_name,
  };
  const paymentForNotify = {
    discount_code_id: payment.discount_code_id,
    discount_code: payment.coupon_code || null,
    discount_pct: payment.discount_pct || null,
    final_amount: payment.final_amount,
    amount: payment.amount,
  };

  try {
    await notifyActivated(userForNotify, planForNotify, paymentForNotify);
  } catch (e) {
    console.error('[SePay] Gửi notifyActivated Telegram thất bại:', e);
  }
}

