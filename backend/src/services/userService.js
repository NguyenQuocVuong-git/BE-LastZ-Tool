import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../config/database.js';

const BCRYPT_ROUNDS = 12;

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/** Mật khẩu ngẫu nhiên đạt rule đăng ký (hoa, thường, số, ký tự đặc biệt, ≥8). */
export function generateSecureRandomPassword(length = 14) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*(),.?":{}|<>';
  const all = upper + lower + digits + special;
  const pick = (pool) => pool[crypto.randomInt(0, pool.length)];

  const must = [pick(upper), pick(lower), pick(digits), pick(special)];
  const buf = [];
  for (let i = must.length; i < Math.max(length, 12); i++) {
    buf.push(pick(all));
  }
  const chars = [...must, ...buf];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Nếu active nhưng đã quá expires_at → chuyển expired (giờ DB).
 * Giữ nguyên session_token để user vẫn gọi được API gia hạn / thanh toán.
 */
export async function refreshUserExpiryIfNeeded(user) {
  if (!user || user.status !== 'active' || !user.expires_at) return;
  await pool.query(
    `UPDATE users SET status = 'expired'
     WHERE id = $1 AND status = 'active' AND expires_at <= NOW()`,
    [user.id],
  );
}

/**
 * Tính expires_at khi kích hoạt / gia hạn: cộng dồn từ max(now, expires_at cũ).
 */
export function calculateNewExpiresAt(currentExpiresAt, durationDays, serverNow = new Date()) {
  const base =
    currentExpiresAt && new Date(currentExpiresAt) > serverNow
      ? new Date(currentExpiresAt)
      : serverNow;
  const ms = base.getTime() + Number(durationDays) * 24 * 60 * 60 * 1000;
  return new Date(ms);
}

/**
 * Kích hoạt hoặc gia hạn user (admin / telegram).
 * @param {object} opts
 * @param {string} opts.userId
 * @param {number} opts.planId
 * @param {string} [opts.activatedBy] 'telegram' | 'admin'
 * @param {string} [opts.note]
 */
export async function activateUser({ userId, planId, activatedBy = 'telegram', note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: planRows } = await client.query(
      `SELECT id, duration_days, price FROM plans WHERE id = $1 AND is_active = true`,
      [planId],
    );
    const plan = planRows[0];
    if (!plan) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'Gói không tồn tại hoặc đã tắt.' };
    }

    const { rows: userRows } = await client.query(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [
      userId,
    ]);
    const user = userRows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'Không tìm thấy user.' };
    }
    if (user.status === 'banned') {
      await client.query('ROLLBACK');
      return { ok: false, message: 'Tài khoản đang bị ban.' };
    }

    const now = new Date();
    const newExpires = calculateNewExpiresAt(user.expires_at, plan.duration_days, now);

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
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, planId, now, newExpires, activatedBy, note || null],
    );

    await client.query('COMMIT');
    return { ok: true, expires_at: newExpires, plan };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return { ok: false, message: 'Lỗi kích hoạt.' };
  } finally {
    client.release();
  }
}

export function remainingFromExpires(expiresAt) {
  if (!expiresAt) return { remaining_days: 0, remaining_hours: 0 };
  const now = new Date();
  const exp = new Date(expiresAt);
  const ms = exp - now;
  if (ms <= 0) return { remaining_days: 0, remaining_hours: 0 };
  const remaining_days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const remaining_hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  return { remaining_days, remaining_hours };
}
