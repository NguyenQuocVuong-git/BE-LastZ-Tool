import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../config/database.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';
import { requireAuth } from '../middleware/auth.js';
import * as couponService from '../services/couponService.js';
import * as userService from '../services/userService.js';

const router = Router();

function toIsoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function buildVietQrUrl({ bankBin, accountNo, amount, addInfo }) {
  const amountInt = Math.round(Number(amount));
  const acc = String(accountNo).replace(/\s/g, '');
  const info = encodeURIComponent(String(addInfo));
  return `https://img.vietqr.io/image/${bankBin}-${acc}-compact2.jpg?amount=${amountInt}&addInfo=${info}`;
}

async function generateUniqueTransferCode(email, durationDays) {
  const local = email
    .split('@')[0]
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 6); // Rút ngắn prefix email còn 6 ký tự
  for (let i = 0; i < 8; i++) {
    // 6 ký tự ngẫu nhiên (3 bytes)
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    // Tổng cộng: local(6) + durationDays(max 3) + "NGAY"(4) + rand(6) = tối đa 19-20 ký tự
    const code = `${local || 'USER'}${durationDays}NGAY${rand}`;
    const c = code.slice(0, 20); // Đảm bảo tối đa 20 ký tự
    const { rows } = await pool.query(`SELECT 1 FROM pending_payments WHERE transfer_code = $1`, [
      c,
    ]);
    if (!rows.length) return c;
  }
  throw new Error('Không tạo được mã CK duy nhất');
}

/**
 * GET /payment/plans
 * Danh sách gói đang bán (public).
 */
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, duration_days, price, is_active, created_at FROM plans WHERE is_active = true ORDER BY duration_days`,
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * POST /payment/check-coupon
 * Kiểm tra mã giảm giá với gói đã chọn (user đã đăng nhập).
 */
router.post('/check-coupon', paymentLimiter, requireAuth, async (req, res) => {
  try {
    const planId = Number(req.body?.plan_id);
    const code = req.body?.code;
    if (!planId) {
      return res.status(400).json({ success: false, message: 'Thiếu plan_id.' });
    }
    const { rows } = await pool.query(
      `SELECT id, price, duration_days, name FROM plans WHERE id = $1 AND is_active = true`,
      [planId],
    );
    const plan = rows[0];
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Gói không tồn tại.' });
    }

    const v = await couponService.validateCouponForOrder({
      rawCode: code,
      userId: req.user.id,
      planPrice: plan.price,
    });
    if (!v.ok) {
      return res.status(400).json({ success: false, message: v.message });
    }

    return res.json({
      success: true,
      data: {
        plan_id: plan.id,
        original_amount: v.original_amount,
        discount_amount: v.discount_amount,
        final_amount: v.final_amount,
        discount_pct: v.codeRow.discount_pct,
        code: v.codeRow.code,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * POST /payment/request
 * Tạo đơn chờ thanh toán + URL VietQR.
 */
router.post('/request', paymentLimiter, requireAuth, async (req, res) => {
  try {
    const planId = Number(req.body?.plan_id);
    const couponRaw = req.body?.discount_code ?? req.body?.code;

    if (!planId) {
      return res.status(400).json({ success: false, message: 'Thiếu plan_id.' });
    }

    const { rows: planRows } = await pool.query(
      `SELECT id, price, duration_days, name FROM plans WHERE id = $1 AND is_active = true`,
      [planId],
    );
    const plan = planRows[0];
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Gói không tồn tại.' });
    }

    // Hủy các đơn đang chờ cũ của user này trước khi tạo đơn mới
    await pool.query(
      `UPDATE pending_payments SET status = 'rejected', note = 'auto_cancelled_for_new_request' 
       WHERE user_id = $1 AND status = 'waiting'`,
      [req.user.id],
    );

    let discount_code_id = null;
    let amount = Number(plan.price);
    let discount_amount = 0;
    let final_amount = amount;

    if (couponRaw && String(couponRaw).trim()) {
      const v = await couponService.validateCouponForOrder({
        rawCode: couponRaw,
        userId: req.user.id,
        planPrice: plan.price,
      });
      if (!v.ok) {
        return res.status(400).json({ success: false, message: v.message });
      }
      discount_code_id = v.codeRow.id;
      amount = v.original_amount;
      discount_amount = v.discount_amount;
      final_amount = v.final_amount;
    }

    const transfer_code = await generateUniqueTransferCode(req.user.email, plan.duration_days);

    const { rows: ins } = await pool.query(
      `INSERT INTO pending_payments
        (user_id, plan_id, discount_code_id, transfer_code, amount, discount_amount, final_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'waiting')
       RETURNING id`,
      [req.user.id, planId, discount_code_id, transfer_code, amount, discount_amount, final_amount],
    );
    const paymentId = ins[0].id;

    const bankBin = process.env.BANK_BIN || '970422';
    const accountNo = process.env.BANK_ACCOUNT_NUMBER || '';
    if (!accountNo) {
      return res.status(500).json({
        success: false,
        message: 'Chưa cấu hình BANK_ACCOUNT_NUMBER.',
      });
    }

    const vietqr_url = buildVietQrUrl({
      bankBin,
      accountNo,
      amount: final_amount,
      addInfo: transfer_code,
    });

    return res.status(201).json({
      success: true,
      message: 'Đã tạo yêu cầu thanh toán.',
      data: {
        payment_id: paymentId,
        payment_status: 'waiting',
        transfer_code,
        amount,
        discount_amount,
        final_amount,
        vietqr_url,
        poll_endpoint: `/payment/${paymentId}/status`,
        should_unlock_features: false,
        plan: {
          id: plan.id,
          name: plan.name,
          duration_days: plan.duration_days,
        },
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * GET /payment/history
 * Lịch sử đơn thanh toán của tài khoản đăng nhập (chờ / đã xác nhận / từ chối).
 * Query: limit (mặc định 20, tối đa 100), offset (mặc định 0).
 */
router.get('/history', paymentLimiter, requireAuth, async (req, res) => {
  try {
    const limitRaw = Number(req.query?.limit);
    const offsetRaw = Number(req.query?.offset);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 100) : 20;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM pending_payments WHERE user_id = $1`,
      [req.user.id],
    );
    const total = countRows[0]?.total ?? 0;

    const { rows } = await pool.query(
      `SELECT pp.id, pp.status, pp.transfer_code, pp.amount, pp.discount_amount, pp.final_amount,
              pp.note, pp.created_at, pp.confirmed_at,
              p.id AS plan_id, p.name AS plan_name, p.duration_days AS plan_duration_days,
              dc.code AS discount_code
       FROM pending_payments pp
       JOIN plans p ON p.id = pp.plan_id
       LEFT JOIN discount_codes dc ON dc.id = pp.discount_code_id
       WHERE pp.user_id = $1
       ORDER BY pp.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset],
    );

    const items = rows.map((r) => ({
      payment_id: r.id,
      status: r.status,
      transfer_code: r.transfer_code,
      amount: Number(r.amount),
      discount_amount: Number(r.discount_amount),
      final_amount: Number(r.final_amount),
      note: r.note ?? null,
      created_at: toIsoOrNull(r.created_at),
      confirmed_at: toIsoOrNull(r.confirmed_at),
      plan: {
        id: r.plan_id,
        name: r.plan_name,
        duration_days: r.plan_duration_days,
      },
      discount_code: r.discount_code ?? null,
    }));

    return res.json({
      success: true,
      data: {
        items,
        total,
        limit,
        offset,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * GET /payment/:paymentId/status
 * FE poll trạng thái đơn thanh toán để mở khoá tính năng ngay sau khi webhook xác nhận.
 */
router.get('/:paymentId/status', paymentLimiter, requireAuth, async (req, res) => {
  try {
    const { paymentId } = req.params;

    const { rows: paymentRows } = await pool.query(
      `SELECT pp.id, pp.user_id, pp.plan_id, pp.status, pp.confirmed_at, pp.amount, pp.discount_amount, pp.final_amount
       FROM pending_payments pp
       WHERE pp.id = $1 AND pp.user_id = $2`,
      [paymentId, req.user.id],
    );
    const payment = paymentRows[0];
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy đơn thanh toán.',
      });
    }

    const { rows: userRows } = await pool.query(
      `SELECT id, status, plan_id, activated_at, expires_at FROM users WHERE id = $1`,
      [req.user.id],
    );
    const user = userRows[0];

    const { remaining_days, remaining_hours } = userService.remainingFromExpires(user?.expires_at);
    const paymentConfirmed = payment.status === 'confirmed';
    const userReady = user?.status === 'active';
    const shouldUnlockFeatures = paymentConfirmed && userReady;

    return res.json({
      success: true,
      data: {
        payment_id: payment.id,
        payment_status: payment.status,
        amount: Number(payment.amount),
        discount_amount: Number(payment.discount_amount),
        final_amount: Number(payment.final_amount),
        confirmed_at: toIsoOrNull(payment.confirmed_at),
        should_unlock_features: shouldUnlockFeatures,
        payment_confirmed: paymentConfirmed,
        user: {
          id: user?.id || req.user.id,
          status: user?.status || 'pending',
          plan_id: user?.plan_id ?? null,
          activated_at: toIsoOrNull(user?.activated_at),
          expires_at: toIsoOrNull(user?.expires_at),
          remaining_days,
          remaining_hours,
        },
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * POST /payment/:paymentId/cancel
 * User tự hủy đơn đang chờ (chọn nhầm gói, muốn tạo lại đơn mới).
 */
router.post('/:paymentId/cancel', paymentLimiter, requireAuth, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const r = await pool.query(
      `UPDATE pending_payments
       SET status = 'rejected',
           confirmed_at = NOW(),
           note = COALESCE(note, 'user_cancelled')
       WHERE id = $1 AND user_id = $2 AND status = 'waiting'
       RETURNING id`,
      [paymentId, req.user.id],
    );

    if (r.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy đơn chờ để huỷ.',
      });
    }

    return res.json({
      success: true,
      message: 'Đã huỷ đơn chờ thanh toán.',
      data: { payment_id: r.rows[0].id, status: 'rejected' },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

export default router;
