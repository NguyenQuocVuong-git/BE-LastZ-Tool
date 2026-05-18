import { pool } from '../config/database.js';
import * as userService from '../services/userService.js';
import { extractSessionToken } from '../utils/sessionToken.js';

/**
 * Đọc header x-session-token (hoặc Bearer), nạp user vào req.user
 */
export async function requireAuth(req, res, next) {
  const token = extractSessionToken(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Thiếu x-session-token.',
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE session_token = $1`,
      [token],
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_INVALID',
        message: 'Phiên không hợp lệ (đăng nhập lại hoặc đã đăng nhập thiết bị khác).',
      });
    }

    await userService.refreshUserExpiryIfNeeded(user);

    const { rows: refreshed } = await pool.query(`SELECT * FROM users WHERE id = $1`, [
      user.id,
    ]);
    const u = refreshed[0];
    if (!u || u.session_token !== token) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_INVALID',
        message: 'Phiên không hợp lệ (đăng nhập lại hoặc đã đăng nhập thiết bị khác).',
      });
    }
    req.user = u;
    req.sessionToken = token;
    next();
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Lỗi máy chủ.',
    });
  }
}

/**
 * Chỉ admin; không phải admin → 404 (giả route không tồn tại)
 */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(404).json({
      success: false,
      message: 'Not Found',
    });
  }
  next();
}

/** Chỉ user đang active và chưa hết hạn gói */
export function requireActiveSubscription(req, res, next) {
  const u = req.user;
  if (!u) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Thiếu x-session-token.',
    });
  }
  if (u.status === 'banned') {
    return res.status(403).json({
      success: false,
      code: 'BANNED',
      message: 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ Admin để được hỗ trợ.',
    });
  }
  if (u.status !== 'active') {
    return res.status(403).json({
      success: false,
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'Cần gói đang hoạt động để tải file.',
    });
  }
  if (!u.expires_at || new Date(u.expires_at) <= new Date()) {
    return res.status(403).json({
      success: false,
      code: 'SUBSCRIPTION_EXPIRED',
      message: 'Gói đã hết hạn. Vui lòng gia hạn.',
    });
  }
  next();
}
