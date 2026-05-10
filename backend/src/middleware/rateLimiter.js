import rateLimit from 'express-rate-limit';
import { extractSessionToken } from '../utils/sessionToken.js';

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) {
    return xf.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * POST /auth/register — 3 lần / giờ / IP
 */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  handler(req, res) {
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Quá nhiều lần đăng ký từ IP này. Thử lại sau 1 giờ.',
    });
  },
});

/**
 * POST /auth/login — 50 lần / 15 phút / IP (lockout theo email xử lý trong route)
 */
export const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  handler(req, res) {
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Quá nhiều lần đăng nhập từ IP này. Thử lại sau.',
    });
  },
});

/**
 * POST /auth/forgot-password — 5 lần / giờ / IP
 */
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  handler(req, res) {
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Quá nhiều lần yêu cầu đặt lại mật khẩu. Thử lại sau 1 giờ.',
    });
  },
});

/**
 * GET /auth/verify — 3 lần / 5 phút / session_token (key trong route)
 */
export function createVerifyLimiter() {
  return rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const token = extractSessionToken(req);
      if (token) return `sess:${token}`;
      return `verify_ip:${clientIp(req)}`;
    },
    handler(req, res) {
      res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        message: 'Ping xác thực quá nhanh. Thử lại sau.',
      });
    },
  });
}

/**
 * POST /payment/* — 30 lần / 15 phút / IP
 */
export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  handler(req, res) {
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Quá nhiều yêu cầu thanh toán. Thử lại sau.',
    });
  },
});

/**
 * POST /admin/* — 10 lần / giờ / IP
 */
export const adminPostLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  handler(req, res) {
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Quá nhiều thao tác admin. Thử lại sau.',
    });
  },
});

export { clientIp };
