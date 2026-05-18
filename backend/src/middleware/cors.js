const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.IS_PRODUCTION === 'true';
}

export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowed = parseAllowedOrigins();
  const devOrigins = isProduction() ? [] : DEFAULT_DEV_ORIGINS;
  const allowList = new Set([...allowed, ...devOrigins]);

  let reflectOrigin = false;
  if (origin && allowList.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    reflectOrigin = true;
  } else if (!isProduction() && !origin) {
    // Postman, curl — không gửi Origin
    reflectOrigin = true;
  } else if (!isProduction() && allowed.length === 0) {
    // Dev chưa cấu hình: cho phép mọi origin (chỉ development)
    res.header('Access-Control-Allow-Origin', origin || '*');
    reflectOrigin = true;
  }

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, x-session-token, Authorization',
  );
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    if (origin && !reflectOrigin && isProduction()) {
      return res.sendStatus(403);
    }
    return res.sendStatus(reflectOrigin || !origin ? 200 : 403);
  }

  if (origin && isProduction() && allowed.length === 0) {
    return res.status(403).json({
      success: false,
      code: 'CORS_FORBIDDEN',
      message: 'Origin không được phép. Cấu hình ALLOWED_ORIGINS.',
    });
  }

  if (origin && isProduction() && !reflectOrigin) {
    return res.status(403).json({
      success: false,
      code: 'CORS_FORBIDDEN',
      message: 'Origin không được phép.',
    });
  }

  next();
}
