import { Router } from 'express';
import { pool } from '../config/database.js';
import {
  registerLimiter,
  loginIpLimiter,
  forgotPasswordLimiter,
  createVerifyLimiter,
  clientIp,
} from '../middleware/rateLimiter.js';
import * as emailService from '../services/emailService.js';
import { requireAuth } from '../middleware/auth.js';
import * as userService from '../services/userService.js';
import { extractSessionToken } from '../utils/sessionToken.js';

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

const forgotPasswordOkMessage =
  'Nếu email thuộc tài khoản trong hệ thống, bạn sẽ nhận được mật khẩu mới qua email.';

function isValidEmailShape(email) {
  if (!email || email.length > 255) return false;
  const at = email.indexOf('@');
  return at > 0 && at < email.length - 1 && !email.includes(' ');
}

/** Giống đăng ký — dùng chung cho đổi mật khẩu */
const strongPasswordRegex = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>]).{8,}$/;
const strongPasswordMessage =
  'Mật khẩu phải từ 8 ký tự, gồm ít nhất 1 chữ hoa, 1 số và 1 ký tự đặc biệt.';

/**
 * POST /auth/register
 * Đăng ký name + email + password; trạng thái pending; lưu IP.
 */
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || '');

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Tên, email và mật khẩu là bắt buộc.',
      });
    }
    if (name.length > 255) {
      return res.status(400).json({
        success: false,
        message: 'Tên không được vượt quá 255 ký tự.',
      });
    }
    if (!strongPasswordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: strongPasswordMessage,
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
      `INSERT INTO users (name, email, password_hash, status, ip_registered)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id, name, email, status, created_at`,
      [name, email, password_hash, ip],
    );

    const session_token = userService.generateSessionToken();
    const { rows: tokRows } = await pool.query(
      `UPDATE users SET session_token = $2 WHERE id = $1 RETURNING session_token`,
      [rows[0].id, session_token],
    );
    const persistedToken = tokRows[0]?.session_token;
    if (!persistedToken) {
      return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        message: 'Không thể tạo phiên.',
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Đăng ký thành công.',
      data: {
        ...rows[0],
        session_token: persistedToken,
      },
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
    const { rows: u2 } = await pool.query(
      `SELECT u.email, u.name, u.status, u.plan_id, u.activated_at, u.expires_at,
              p.name AS plan_name, p.duration_days AS plan_duration_days, p.price AS plan_price
       FROM users u
       LEFT JOIN plans p ON p.id = u.plan_id
       WHERE u.id = $1`,
      [user.id],
    );
    const fresh = u2[0];

    if (fresh.status === 'banned') {
      return res.status(403).json({
        success: false,
        code: 'BANNED',
        message: 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ Admin để được hỗ trợ.',
      });
    }

    const session_token = userService.generateSessionToken();
    const { rows: tokRows } = await pool.query(
      `UPDATE users SET
        session_token = $2,
        last_login_at = NOW(),
        last_login_ip = $3,
        failed_login_attempts = 0,
        locked_until = NULL
      WHERE id = $1
      RETURNING session_token`,
      [user.id, session_token, ip],
    );
    const persistedToken = tokRows[0]?.session_token;
    if (!persistedToken) {
      return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        message: 'Không thể tạo phiên.',
      });
    }

    const { remaining_days, remaining_hours } = userService.remainingFromExpires(fresh.expires_at);

    return res.json({
      success: true,
      message: 'Đăng nhập thành công.',
      data: {
        session_token: persistedToken,
        email: fresh.email,
        name: fresh.name,
        activated_at: fresh.activated_at,
        expires_at: fresh.expires_at,
        remaining_days,
        remaining_hours,
        status: fresh.status,
        plan_id: fresh.plan_id,
        plan_name: fresh.plan_name ?? null,
        plan_duration_days: fresh.plan_duration_days ?? null,
        plan_price: fresh.plan_price != null ? Number(fresh.plan_price) : null,
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
 * POST /auth/forgot-password
 * Body: { email } — gửi mật khẩu ngẫu nhiên qua SMTP; phản hồi chung để hạn chế lộ email.
 */
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    if (!emailService.isSmtpConfigured()) {
      return res.status(503).json({
        success: false,
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'Máy chủ chưa cấu hình gửi email. Liên hệ quản trị viên.',
      });
    }

    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();

    if (!email || !isValidEmailShape(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email không hợp lệ.',
      });
    }

    const { rows } = await pool.query(`SELECT id, email, name, status FROM users WHERE email = $1`, [
      email,
    ]);
    const user = rows[0];

    if (!user || user.status === 'banned') {
      return res.json({
        success: true,
        message: forgotPasswordOkMessage,
      });
    }

    const plain = userService.generateSecureRandomPassword();

    try {
      await emailService.sendPasswordResetEmail(user.email, plain, user.name || undefined);
    } catch (e) {
      console.error('sendPasswordResetEmail failed', e.message || e);
      return res.json({
        success: true,
        message: forgotPasswordOkMessage,
      });
    }

    const password_hash = await userService.hashPassword(plain);
    try {
      await pool.query(
        `UPDATE users SET
          password_hash = $2,
          failed_login_attempts = 0,
          locked_until = NULL,
          session_token = NULL
        WHERE id = $1`,
        [user.id, password_hash],
      );
    } catch (updErr) {
      console.error('password reset: email sent but DB update failed', user.id, updErr);
      return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        message: 'Lỗi máy chủ.',
      });
    }

    return res.json({
      success: true,
      message: forgotPasswordOkMessage,
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
 * POST /auth/change-password
 * Đổi mật khẩu khi đã đăng nhập; bắt buộc đúng mật khẩu cũ trước khi cập nhật.
 */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    if (u.status === 'banned') {
      return res.status(403).json({
        success: false,
        code: 'BANNED',
        message: 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ Admin để được hỗ trợ.',
      });
    }

    const oldPassword = String(req.body?.old_password ?? req.body?.current_password ?? '');
    const newPassword = String(req.body?.new_password ?? '');

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Mật khẩu hiện tại và mật khẩu mới là bắt buộc.',
      });
    }

    const match = await userService.verifyPassword(oldPassword, u.password_hash);
    if (!match) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_OLD_PASSWORD',
        message: 'Mật khẩu hiện tại không đúng.',
      });
    }

    if (oldPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Mật khẩu mới phải khác mật khẩu hiện tại.',
      });
    }

    if (!strongPasswordRegex.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: strongPasswordMessage,
      });
    }

    const password_hash = await userService.hashPassword(newPassword);
    await pool.query(
      `UPDATE users SET
        password_hash = $2,
        failed_login_attempts = 0,
        locked_until = NULL
      WHERE id = $1`,
      [u.id, password_hash],
    );

    return res.json({
      success: true,
      message: 'Đã đổi mật khẩu thành công.',
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
    const token = extractSessionToken(req);
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
        message: 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ Admin để được hỗ trợ.',
        data: { valid: false },
      });
    }

    const { remaining_days, remaining_hours } = userService.remainingFromExpires(u.expires_at);

    return res.json({
      success: true,
      message: 'OK',
      data: {
        valid: true,
        status: u.status,
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
