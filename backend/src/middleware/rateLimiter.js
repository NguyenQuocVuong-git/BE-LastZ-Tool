import rateLimit from 'express-rate-limit';
import { extractSessionToken } from '../utils/sessionToken.js';
import { PgRateLimitStore } from './pgRateLimitStore.js';

function usePgStore() {
  return (
    process.env.USE_PG_RATE_LIMIT === 'true' ||
    process.env.NODE_ENV === 'production' ||
    process.env.IS_PRODUCTION === 'true'
  );
}

function limiterOptions(windowMs, max, prefix) {
  const opts = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (usePgStore()) {
    const store = new PgRateLimitStore(prefix);
    store.init({ windowMs });
    opts.store = store;
  }
  return opts;
}

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
  ...limiterOptions(60 * 60 * 1000, 15, 'register'),
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
  ...limiterOptions(15 * 60 * 1000, 50, 'login'),
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
  ...limiterOptions(60 * 60 * 1000, 5, 'forgot'),
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
    ...limiterOptions(5 * 60 * 1000, 3, 'verify'),
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
  ...limiterOptions(15 * 60 * 1000, 30, 'payment'),
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
  ...limiterOptions(60 * 60 * 1000, 10, 'admin'),
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
