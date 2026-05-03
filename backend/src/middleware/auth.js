import { pool } from '../config/database.js';
import * as userService from '../services/userService.js';

/**
 * Đọc header x-session-token, nạp user vào req.user
 */
export async function requireAuth(req, res, next) {
  const raw = req.headers['x-session-token'];
  const token = typeof raw === 'string' ? raw.trim() : '';
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
        code: 'UNAUTHORIZED',
        message: 'Phiên không hợp lệ.',
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
        code: 'UNAUTHORIZED',
        message: 'Phiên không hợp lệ.',
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
