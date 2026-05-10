/**
 * Chuẩn hóa token để khớp DB (login/register luôn dùng hex thường).
 */
function normalize(value) {
  let t = String(value).trim();
  if (/^bearer\s+/i.test(t)) {
    t = t.replace(/^bearer\s+/i, '').trim();
  }
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return t.toLowerCase();
  }
  return t;
}

/**
 * Đọc session token từ x-session-token hoặc Authorization: Bearer ...
 */
export function extractSessionToken(req) {
  const rawHeader = req.headers['x-session-token'];
  if (typeof rawHeader === 'string') {
    const t = normalize(rawHeader);
    if (t) return t;
  }
  const rawAuth = req.headers['authorization'];
  if (typeof rawAuth === 'string') {
    const t = normalize(rawAuth);
    if (t) return t;
  }
  return '';
}
