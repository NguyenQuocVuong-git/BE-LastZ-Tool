import { pool } from '../config/database.js';
import * as userService from './userService.js';
import * as couponService from './couponService.js';
import { telegramChatId } from '../config/telegram.js';

function uuidFromCompact(compact32) {
  if (!compact32 || compact32.length !== 32) return null;
  const h = compact32.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function compactFromUuid(uuid) {
  return String(uuid).replace(/-/g, '').toUpperCase();
}

function formatMoney(n) {
  return Number(n).toLocaleString('vi-VN');
}

function formatDateVi(d) {
  if (!d) return '';
  const x = new Date(d);
  const pad = (u) => String(u).padStart(2, '0');
  return `${pad(x.getDate())}/${pad(x.getMonth() + 1)}/${x.getFullYear()} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

function isAdmin(fromId) {
  if (!telegramChatId) return false;
  return String(fromId) === String(telegramChatId);
}

/**
 * Gửi thông báo đơn mới cho admin (có hiển thị mã giảm giá nếu có).
 */
export async function notifyNewPayment(bot, paymentId) {
  if (!bot) return;

  const { rows } = await pool.query(
    `SELECT pp.*, u.email, p.name as plan_name, p.duration_days,
            dc.code as coupon_code, dc.discount_pct
     FROM pending_payments pp
     JOIN users u ON u.id = pp.user_id
     JOIN plans p ON p.id = pp.plan_id
     LEFT JOIN discount_codes dc ON dc.id = pp.discount_code_id
     WHERE pp.id = $1`,
    [paymentId],
  );
  const row = rows[0];
  if (!row) return;

  const compact = compactFromUuid(row.id);
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Xác nhận đã nhận tiền', callback_data: `1a${compact}` },
        { text: '❌ Từ chối', callback_data: `1r${compact}` },
      ],
    ],
  };

  let text;
  if (row.discount_code_id) {
    text =
      `🆕 Đăng ký mới\n` +
      `👤 Email: ${row.email}\n` +
      `📦 Gói: ${row.duration_days} ngày\n` +
      `🏷️ Mã giảm: ${row.coupon_code} (-${row.discount_pct}%)\n` +
      `💰 Giá gốc:  ${formatMoney(row.amount)}đ\n` +
      `✂️ Giảm:     -${formatMoney(row.discount_amount)}đ\n` +
      `💵 Thực thu: ${formatMoney(row.final_amount)}đ\n` +
      `🏦 Nội dung CK: ${row.transfer_code}`;
  } else {
    text =
      `🆕 Đăng ký mới\n` +
      `👤 Email: ${row.email}\n` +
      `📦 Gói: ${row.duration_days} ngày\n` +
      `💰 Số tiền: ${formatMoney(row.final_amount)}đ\n` +
      `🏦 Nội dung CK: ${row.transfer_code}`;
  }

  const sent = await bot.sendMessage(telegramChatId, text, { reply_markup: keyboard });
  await pool.query(`UPDATE pending_payments SET telegram_msg_id = $2 WHERE id = $1`, [
    paymentId,
    sent.message_id,
  ]);
}

/**
 * Đăng ký xử lý callback Telegram (webhook).
 */
export function registerTelegramCallbacks(bot) {
  if (!bot) return;

  bot.on('callback_query', async (query) => {
    const fromId = query.from?.id;
    if (!isAdmin(fromId)) {
      await bot.answerCallbackQuery(query.id, { text: 'Không có quyền.', show_alert: true });
      return;
    }

    const data = query.data || '';
    if (data.length < 34) {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const action = data.slice(0, 2);
    const compact = data.slice(2);
    const paymentId = uuidFromCompact(compact);
    if (!paymentId) {
      await bot.answerCallbackQuery(query.id, { text: 'Dữ liệu không hợp lệ.', show_alert: true });
      return;
    }

    try {
      if (action === '1r') {
        await handleReject(bot, query, paymentId);
        return;
      }
      if (action === '1a') {
        await handleApproveStep1(bot, query, paymentId);
        return;
      }
      if (action === '2c') {
        await handleCancelStep2(bot, query, paymentId);
        return;
      }
      if (action === '2a') {
        await handleApproveStep2(bot, query, paymentId);
        return;
      }
    } catch (e) {
      console.error(e);
      await bot.answerCallbackQuery(query.id, { text: 'Lỗi server.', show_alert: true });
    }
  });
}

async function handleReject(bot, query, paymentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM pending_payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );
    const pay = rows[0];
    if (!pay) {
      await client.query('ROLLBACK');
      await bot.answerCallbackQuery(query.id, { text: 'Không tìm thấy đơn.', show_alert: true });
      return;
    }
    if (pay.status !== 'waiting') {
      await client.query('ROLLBACK');
      await bot.answerCallbackQuery(query.id, { text: 'Đơn đã được xử lý rồi', show_alert: true });
      return;
    }
    await client.query(
      `UPDATE pending_payments SET status = 'rejected', confirmed_at = NOW() WHERE id = $1`,
      [paymentId],
    );
    await client.query(
      `INSERT INTO admin_logs (action, target_id, detail) VALUES ($1, $2, $3)`,
      [
        'payment_reject',
        pay.user_id,
        JSON.stringify({ payment_id: paymentId, via: 'telegram' }),
      ],
    );
    await client.query('COMMIT');
    await bot.answerCallbackQuery(query.id, { text: 'Đã từ chối.' });
    const newText = `❌ Đơn đã bị từ chối.\n🏦 CK: ${pay.transfer_code}`;
    if (pay.telegram_msg_id) {
      await bot.editMessageText(newText, {
        chat_id: telegramChatId,
        message_id: pay.telegram_msg_id,
      });
    }
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function handleCancelStep2(bot, query, paymentId) {
  const { rows } = await pool.query(
    `SELECT pp.*, u.email, p.duration_days,
            dc.code as coupon_code, dc.discount_pct
     FROM pending_payments pp
     JOIN users u ON u.id = pp.user_id
     JOIN plans p ON p.id = pp.plan_id
     LEFT JOIN discount_codes dc ON dc.id = pp.discount_code_id
     WHERE pp.id = $1`,
    [paymentId],
  );
  const row = rows[0];
  if (!row || row.status !== 'waiting') {
    await bot.answerCallbackQuery(query.id, { text: 'Đơn đã được xử lý rồi', show_alert: true });
    return;
  }

  const compact = compactFromUuid(row.id);
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Xác nhận đã nhận tiền', callback_data: `1a${compact}` },
        { text: '❌ Từ chối', callback_data: `1r${compact}` },
      ],
    ],
  };

  let text;
  if (row.discount_code_id) {
    text =
      `🆕 Đăng ký mới\n` +
      `👤 Email: ${row.email}\n` +
      `📦 Gói: ${row.duration_days} ngày\n` +
      `🏷️ Mã giảm: ${row.coupon_code} (-${row.discount_pct}%)\n` +
      `💰 Giá gốc:  ${formatMoney(row.amount)}đ\n` +
      `✂️ Giảm:     -${formatMoney(row.discount_amount)}đ\n` +
      `💵 Thực thu: ${formatMoney(row.final_amount)}đ\n` +
      `🏦 Nội dung CK: ${row.transfer_code}`;
  } else {
    text =
      `🆕 Đăng ký mới\n` +
      `👤 Email: ${row.email}\n` +
      `📦 Gói: ${row.duration_days} ngày\n` +
      `💰 Số tiền: ${formatMoney(row.final_amount)}đ\n` +
      `🏦 Nội dung CK: ${row.transfer_code}`;
  }

  await bot.answerCallbackQuery(query.id, { text: 'Đã huỷ xác nhận.' });
  if (row.telegram_msg_id) {
    await bot.editMessageText(text, {
      chat_id: telegramChatId,
      message_id: row.telegram_msg_id,
      reply_markup: keyboard,
    });
  }
}

async function handleApproveStep1(bot, query, paymentId) {
  const { rows } = await pool.query(
    `SELECT pp.*, u.email, p.duration_days
     FROM pending_payments pp
     JOIN users u ON u.id = pp.user_id
     JOIN plans p ON p.id = pp.plan_id
     WHERE pp.id = $1`,
    [paymentId],
  );
  const pay = rows[0];
  if (!pay) {
    await bot.answerCallbackQuery(query.id, { text: 'Không tìm thấy đơn.', show_alert: true });
    return;
  }
  if (pay.status !== 'waiting') {
    await bot.answerCallbackQuery(query.id, { text: 'Đơn đã được xử lý rồi', show_alert: true });
    return;
  }

  const now = new Date();
  const newExpires = userService.calculateNewExpiresAt(
    (await pool.query(`SELECT expires_at FROM users WHERE id = $1`, [pay.user_id])).rows[0]
      ?.expires_at,
    pay.duration_days,
    now,
  );

  const compact = compactFromUuid(paymentId);
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Đồng ý — Active ngay', callback_data: `2a${compact}` },
        { text: '↩️ Huỷ', callback_data: `2c${compact}` },
      ],
    ],
  };

  const text =
    `⚠️ Xác nhận kích hoạt?\n` +
    `👤 ${pay.email}\n` +
    `📦 Gói ${pay.duration_days} ngày\n` +
    `📅 Hết hạn: ${formatDateVi(newExpires)}`;

  await bot.answerCallbackQuery(query.id);
  if (pay.telegram_msg_id) {
    await bot.editMessageText(text, {
      chat_id: telegramChatId,
      message_id: pay.telegram_msg_id,
      reply_markup: keyboard,
    });
  }
}

async function handleApproveStep2(bot, query, paymentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT pp.*, u.email, p.duration_days, p.id as plan_ref_id
       FROM pending_payments pp
       JOIN users u ON u.id = pp.user_id
       JOIN plans p ON p.id = pp.plan_id
       WHERE pp.id = $1 FOR UPDATE`,
      [paymentId],
    );
    const pay = rows[0];
    if (!pay) {
      await client.query('ROLLBACK');
      await bot.answerCallbackQuery(query.id, { text: 'Không tìm thấy đơn.', show_alert: true });
      return;
    }
    if (pay.status !== 'waiting') {
      await client.query('ROLLBACK');
      await bot.answerCallbackQuery(query.id, { text: 'Đơn đã được xử lý rồi', show_alert: true });
      return;
    }

    const act = await activatePaymentInTransaction(client, pay, paymentId);
    if (!act.ok) {
      await client.query('ROLLBACK');
      await bot.answerCallbackQuery(query.id, { text: act.message, show_alert: true });
      return;
    }

    await client.query('COMMIT');
    await bot.answerCallbackQuery(query.id, { text: 'Đã kích hoạt.' });

    const successText =
      `✅ Đã active thành công!\n` +
      `👤 Email: ${pay.email}\n` +
      `📅 Hết hạn: ${formatDateVi(act.expires_at)}`;

    if (pay.telegram_msg_id) {
      await bot.editMessageText(successText, {
        chat_id: telegramChatId,
        message_id: pay.telegram_msg_id,
      });
    }
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* noop */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Kích hoạt user + cập nhật payment + coupon atomic (trong transaction đang mở).
 */
async function activatePaymentInTransaction(client, pay, paymentId) {
  const userId = pay.user_id;
  const planId = pay.plan_id;

  const { rows: userRows } = await client.query(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [
    userId,
  ]);
  const user = userRows[0];
  if (!user) return { ok: false, message: 'User không tồn tại.' };
  if (user.status === 'banned') return { ok: false, message: 'User đang bị ban.' };

  const now = new Date();
  const { rows: planRows } = await client.query(
    `SELECT duration_days FROM plans WHERE id = $1`,
    [planId],
  );
  const duration_days = planRows[0]?.duration_days;
  if (!duration_days) return { ok: false, message: 'Gói không hợp lệ.' };

  const newExpires = userService.calculateNewExpiresAt(user.expires_at, duration_days, now);

  await client.query(
    `UPDATE users SET
      status = 'active',
      plan_id = $2,
      activated_at = COALESCE(activated_at, $3),
      expires_at = $4,
      failed_login_attempts = 0,
      locked_until = NULL
    WHERE id = $1`,
    [userId, planId, now, newExpires],
  );

  await client.query(
    `INSERT INTO activation_logs (user_id, plan_id, activated_at, expires_at, activated_by, note)
     VALUES ($1, $2, $3, $4, 'telegram', $5)`,
    [userId, planId, now, newExpires, `payment ${paymentId}`],
  );

  if (pay.discount_code_id) {
    const inc = await couponService.atomicIncrementCouponUse(client, pay.discount_code_id);
    if (!inc) {
      return { ok: false, message: 'Mã giảm giá vừa hết lượt. Xử lý thủ công.' };
    }
    await couponService.insertDiscountUsage(client, {
      discountCodeId: pay.discount_code_id,
      userId,
      paymentId,
      original_amount: pay.amount,
      discount_amount: pay.discount_amount,
      final_amount: pay.final_amount,
    });
  }

  await client.query(
    `UPDATE pending_payments SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
    [paymentId],
  );

  await client.query(
    `INSERT INTO admin_logs (action, target_id, detail) VALUES ($1, $2, $3)`,
    [
      'payment_confirm',
      userId,
      JSON.stringify({ payment_id: paymentId, expires_at: newExpires.toISOString() }),
    ],
  );

  return { ok: true, expires_at: newExpires };
}
