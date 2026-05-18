import crypto from 'crypto';

function pepper() {
  const s = process.env.SESSION_SECRET?.trim();
  if (!s) {
    if (process.env.NODE_ENV === 'production' || process.env.IS_PRODUCTION === 'true') {
      throw new Error('SESSION_SECRET is required in production');
    }
    return 'dev-only-insecure-pepper-change-me';
  }
  return s;
}

export function hashOpaqueToken(plainToken) {
  return crypto.createHmac('sha256', pepper()).update(String(plainToken)).digest('hex');
}

/** Alias: hash session token trước khi lưu DB. */
export const hashSessionToken = hashOpaqueToken;

export function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function timingSafeEqualStrings(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
