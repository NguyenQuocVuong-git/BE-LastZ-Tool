import { pool } from '../config/database.js';

/**
 * Validate mã giảm giá cho user + plan (chưa tạo đơn).
 * Trả về { ok, message?, original_amount, discount_amount, final_amount, codeRow? }
 */
export async function validateCouponForOrder({ rawCode, userId, planPrice }) {
  if (!rawCode || !String(rawCode).trim()) {
    return { ok: false, message: 'Thiếu mã giảm giá.' };
  }
  const code = String(rawCode).trim().toUpperCase();

  const { rows } = await pool.query(`SELECT * FROM discount_codes WHERE UPPER(code) = $1`, [code]);
  const row = rows[0];
  if (!row) return { ok: false, message: 'Mã không tồn tại.' };
  if (!row.is_active) return { ok: false, message: 'Mã không còn hiệu lực.' };
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    return { ok: false, message: 'Mã đã hết hạn.' };
  }
  if (row.used_count >= row.max_uses) {
    return { ok: false, message: 'Mã đã hết lượt sử dụng.' };
  }

  const dup = await pool.query(
    `SELECT 1 FROM discount_usages WHERE discount_code_id = $1 AND user_id = $2`,
    [row.id, userId],
  );
  if (dup.rowCount > 0) {
    return { ok: false, message: 'Bạn đã sử dụng mã này rồi.' };
  }

  const original_amount = Number(planPrice);
  const discount_amount = Math.round((original_amount * Number(row.discount_pct)) / 100);
  const final_amount = original_amount - discount_amount;

  return {
    ok: true,
    original_amount,
    discount_amount,
    final_amount,
    codeRow: row,
  };
}

/**
 * Atomic tăng used_count khi admin confirm; rowCount = 0 → hết lượt (race).
 */
export async function atomicIncrementCouponUse(client, discountCodeId) {
  const r = await client.query(
    `UPDATE discount_codes
     SET used_count = used_count + 1
     WHERE id = $1 AND used_count < max_uses
     RETURNING id`,
    [discountCodeId],
  );
  return r.rowCount > 0;
}

/**
 * Ghi discount_usages trong transaction (sau khi increment thành công).
 */
export async function insertDiscountUsage(client, { discountCodeId, userId, paymentId, original_amount, discount_amount, final_amount }) {
  await client.query(
    `INSERT INTO discount_usages (discount_code_id, user_id, payment_id, original_amount, discount_amount, final_amount)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [discountCodeId, userId, paymentId, original_amount, discount_amount, final_amount],
  );
}
