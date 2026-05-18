export function appPublicBaseUrl() {
  const raw =
    process.env.APP_PUBLIC_URL?.trim() ||
    process.env.FRONTEND_URL?.trim() ||
    process.env.SERVER_URL?.trim() ||
    '';
  return raw.replace(/\/$/, '');
}
