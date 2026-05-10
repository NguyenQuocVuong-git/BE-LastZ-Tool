import nodemailer from 'nodemailer';

function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_PORT &&
      process.env.SMTP_FROM?.trim(),
  );
}

function createTransport() {
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure =
    process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1' || port === 465;
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS ?? '';

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST.trim(),
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });
}

/**
 * @param {string} to
 * @param {string} plainPassword
 * @param {string} [displayName]
 */
export async function sendPasswordResetEmail(to, plainPassword, displayName) {
  if (!smtpConfigured()) {
    const err = new Error('SMTP_NOT_CONFIGURED');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const from = process.env.SMTP_FROM.trim();
  const subject = process.env.SMTP_PASSWORD_RESET_SUBJECT || 'Mật khẩu đăng nhập mới';
  const appName = process.env.APP_NAME || 'Ứng dụng';

  const greeting = displayName ? `Xin chào ${displayName},` : 'Xin chào,';
  const text = `${greeting}

Bạn vừa yêu cầu đặt lại mật khẩu cho tài khoản ${to}.

Mật khẩu mới của bạn là: ${plainPassword}

Vui lòng đăng nhập và đổi mật khẩu nếu hệ thống hỗ trợ.

Nếu bạn không yêu cầu thao tác này, hãy liên hệ admin ngay.

— ${appName}`;

  await createTransport().sendMail({
    from,
    to,
    subject,
    text,
  });
}

export function isSmtpConfigured() {
  return smtpConfigured();
}
