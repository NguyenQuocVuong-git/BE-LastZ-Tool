import { telegramChatId, bot } from '../config/telegram.js';

function formatMoney(n) {
  return Number(n).toLocaleString('vi-VN');
}

function formatDateVi(d) {
  if (!d) return '';
  const x = new Date(d);
  const pad = (u) => String(u).padStart(2, '0');
  return `${pad(x.getDate())}/${pad(x.getMonth() + 1)}/${x.getFullYear()} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

export function formatPaymentMessage(row) {
  if (row.discount_code_id) {
    return (
      `🆕 Đăng ký mới\n` +
      `👤 Email: ${row.email}\n` +
      `📦 Gói: ${row.duration_days} ngày\n` +
      `🏷️ Mã giảm: ${row.coupon_code} (-${row.discount_pct}%)\n` +
      `💰 Giá gốc:  ${formatMoney(row.amount)}đ\n` +
      `✂️ Giảm:     -${formatMoney(row.discount_amount)}đ\n` +
      `💵 Thực thu: ${formatMoney(row.final_amount)}đ\n` +
      `🏦 Nội dung CK: ${row.transfer_code}`
    );
  } else {
    return (
      `🆕 Đăng ký mới\n` +
      `👤 Email: ${row.email}\n` +
      `📦 Gói: ${row.duration_days} ngày\n` +
      `💰 Số tiền: ${formatMoney(row.final_amount)}đ\n` +
      `🏦 Nội dung CK: ${row.transfer_code}`
    );
  }
}

function formatDate(d) {
  if (!d) return '';
  const x = new Date(d);
  const pad = (u) => String(u).padStart(2, '0');
  return `${pad(x.getDate())}/${pad(x.getMonth() + 1)}/${x.getFullYear()} ${pad(x.getHours())}:${pad(
    x.getMinutes(),
  )}`;
}

export async function notifyActivated(user, plan, payment) {
  if (!bot || !telegramChatId) return;

  const hasDiscount = payment.discount_code_id !== null && payment.discount_code_id !== undefined;
  const discountCode = payment.discount_code ?? '';
  const discountPct = payment.discount_pct ?? '';

  const text = hasDiscount
    ? `✅ Tự động active!\n\n` +
      `👤 ${user.email}\n` +
      `📦 Gói: ${plan.name}\n` +
      `🏷️ Mã giảm: ${discountCode} (-${discountPct}%)\n` +
      `💰 Nhận: ${formatMoney(payment.final_amount)} (gốc ${formatMoney(payment.amount)})\n` +
      `📅 Hết hạn: ${formatDate(user.expires_at)}`
    : `✅ Tự động active!\n\n` +
      `👤 ${user.email}\n` +
      `📦 Gói: ${plan.name}\n` +
      `💰 Nhận: ${formatMoney(payment.final_amount)}\n` +
      `📅 Hết hạn: ${formatDate(user.expires_at)}`;

  await bot.sendMessage(telegramChatId, text, { parse_mode: 'Markdown' });
}
