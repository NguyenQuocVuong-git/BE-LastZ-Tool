import { Router } from 'express';
import { pool } from '../config/database.js';
import {
  registerLimiter,
  loginIpLimiter,
  createVerifyLimiter,
  clientIp,
} from '../middleware/rateLimiter.js';
import { requireAuth } from '../middleware/auth.js';
import * as userService from '../services/userService.js';

const router = Router();
const verifyLimiter = createVerifyLimiter();

/** Domain email tạm thời — chặn đăng ký */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'tempmail.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'yopmail.com',
  'yopmail.fr',
  'throwaway.email',
  '10minutemail.com',
  'temp-mail.org',
  'fakeinbox.com',
  'trashmail.com',
  'getnada.com',
  'maildrop.cc',
  'dispostable.com',
]);

/** Đếm sai mật khẩu theo IP + email trong cửa sổ 15 phút */
const loginFailWindowMs = 15 * 60 * 1000;
const loginFailTracker = new Map();

function loginFailKey(ip, email) {
  return `${ip}::${email.toLowerCase().trim()}`;
}

function pruneLoginFails() {
  const now = Date.now();
  for (const [k, v] of loginFailTracker) {
    if (now - v.since > loginFailWindowMs) loginFailTracker.delete(k);
  }
}

function recordLoginFailure(ip, email) {
  pruneLoginFails();
  const k = loginFailKey(ip, email);
  const now = Date.now();
  let e = loginFailTracker.get(k);
  if (!e || now - e.since > loginFailWindowMs) {
    e = { count: 0, since: now };
  }
  e.count += 1;
  loginFailTracker.set(k, e);
  return e.count;
}

function clearLoginFailures(ip, email) {
  loginFailTracker.delete(loginFailKey(ip, email));
}

function isDisposableEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return true;
  const domain = email.slice(at + 1).toLowerCase();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/**
 * POST /auth/register
 * Đăng ký email + password; trạng thái pending; lưu IP.
 */
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email và mật khẩu là bắt buộc.',
      });
    }
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Mật khẩu tối thiểu 8 ký tự.',
      });
    }
    if (isDisposableEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Không chấp nhận email tạm thời.',
      });
    }

    const ip = clientIp(req);
    const password_hash = await userService.hashPassword(password);

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, status, ip_registered)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id, email, status, created_at`,
      [email, password_hash, ip],
    );

    return res.status(201).json({
      success: true,
      message: 'Đăng ký thành công. Chờ admin kích hoạt sau thanh toán.',
      data: rows[0],
    });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Email đã được sử dụng.',
      });
    }
    console.error(e);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Lỗi máy chủ.',
    });
  }
});

/**
 * POST /auth/login
 * Đăng nhập; 1 session duy nhất; khóa 15 phút sau 5 lần sai (theo IP+email).
 */
router.post('/login', loginIpLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || '');
    const ip = clientIp(req);

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email và mật khẩu là bắt buộc.',
      });
    }

    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    const user = rows[0];

    if (!user) {
      recordLoginFailure(ip, email);
      return res.status(401).json({
        success: false,
        message: 'Email hoặc mật khẩu không đúng.',
      });
    }

    const now = new Date();
    if (user.locked_until && new Date(user.locked_until) > now) {
      return res.status(423).json({
        success: false,
        code: 'LOCKED',
        message: 'Tài khoản tạm khóa do đăng nhập sai nhiều lần. Thử lại sau.',
      });
    }

    const ok = await userService.verifyPassword(password, user.password_hash);
    if (!ok) {
      const n = recordLoginFailure(ip, email);
      if (n >= 5) {
        const until = new Date(Date.now() + 15 * 60 * 1000);
        await pool.query(`UPDATE users SET locked_until = $2 WHERE id = $1`, [user.id, until]);
      }
      await pool.query(
        `UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1`,
        [user.id],
      );
      return res.status(401).json({
        success: false,
        message: 'Email hoặc mật khẩu không đúng.',
      });
    }

    clearLoginFailures(ip, email);
    await userService.refreshUserExpiryIfNeeded(user);
    const { rows: u2 } = await pool.query(`SELECT * FROM users WHERE id = $1`, [user.id]);
    const fresh = u2[0];

    if (fresh.status === 'banned') {
      return res.status(403).json({
        success: false,
        code: 'BANNED',
        message: 'Tài khoản bị khóa.',
      });
    }

    const session_token = userService.generateSessionToken();
    await pool.query(
      `UPDATE users SET
        session_token = $2,
        last_login_at = NOW(),
        last_login_ip = $3,
        failed_login_attempts = 0,
        locked_until = NULL
      WHERE id = $1`,
      [fresh.id, session_token, ip],
    );

    const { remaining_days, remaining_hours } = userService.remainingFromExpires(fresh.expires_at);

    return res.json({
      success: true,
      message: 'Đăng nhập thành công.',
      data: {
        session_token,
        expires_at: fresh.expires_at,
        remaining_days,
        remaining_hours,
        status: fresh.status,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Lỗi máy chủ.',
    });
  }
});

/**
 * GET /auth/verify
 * Hot path: tool gọi mỗi ~5 phút với x-session-token.
 */
router.get('/verify', verifyLimiter, async (req, res) => {
  try {
    const raw = req.headers['x-session-token'];
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (!token) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Thiếu phiên.',
      });
    }

    const { rows } = await pool.query(`SELECT * FROM users WHERE session_token = $1`, [token]);
    const user = rows[0];

    if (!user) {
      return res.status(200).json({
        success: false,
        code: 'SESSION_REPLACED',
        message: 'Phiên đã hết hiệu lực (đăng nhập nơi khác).',
        data: { valid: false },
      });
    }

    await userService.refreshUserExpiryIfNeeded(user);
    const { rows: r2 } = await pool.query(`SELECT * FROM users WHERE id = $1`, [user.id]);
    const u = r2[0];

    if (u.status === 'banned') {
      return res.json({
        success: false,
        code: 'BANNED',
        message: 'Tài khoản bị khóa.',
        data: { valid: false },
      });
    }
    if (u.status === 'pending') {
      return res.json({
        success: false,
        code: 'PENDING',
        message: 'Tài khoản chưa kích hoạt.',
        data: { valid: false },
      });
    }
    if (u.status === 'expired') {
      return res.json({
        success: false,
        code: 'EXPIRED',
        message: 'Gói đã hết hạn.',
        data: { valid: false },
      });
    }

    if (u.status === 'active' && u.expires_at && new Date(u.expires_at) <= new Date()) {
      await pool.query(`UPDATE users SET status = 'expired', session_token = NULL WHERE id = $1`, [
        u.id,
      ]);
      return res.json({
        success: false,
        code: 'EXPIRED',
        message: 'Gói đã hết hạn.',
        data: { valid: false },
      });
    }

    const { remaining_days, remaining_hours } = userService.remainingFromExpires(u.expires_at);

    return res.json({
      success: true,
      message: 'OK',
      data: {
        valid: true,
        expires_at: u.expires_at,
        remaining_days,
        remaining_hours,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Lỗi máy chủ.',
    });
  }
});

/**
 * GET /auth/me
 * Thông tin user hiện tại (cần x-session-token).
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const { remaining_days, remaining_hours } = userService.remainingFromExpires(u.expires_at);
    return res.json({
      success: true,
      data: {
        id: u.id,
        email: u.email,
        role: u.role,
        status: u.status,
        plan_id: u.plan_id,
        activated_at: u.activated_at,
        expires_at: u.expires_at,
        remaining_days,
        remaining_hours,
        ip_registered: u.ip_registered,
        last_login_at: u.last_login_at,
        last_login_ip: u.last_login_ip,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      message: 'Lỗi máy chủ.',
    });
  }
});

export default router;
