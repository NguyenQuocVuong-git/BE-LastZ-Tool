import nodemailer from 'nodemailer';
import { appPublicBaseUrl } from '../utils/appUrl.js';

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
 * @param {string} resetLink
 * @param {string} [displayName]
 */
export async function sendPasswordResetLinkEmail(to, resetLink, displayName) {
  if (!smtpConfigured()) {
    const err = new Error('SMTP_NOT_CONFIGURED');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const from = process.env.SMTP_FROM.trim();
  const subject = process.env.SMTP_PASSWORD_RESET_SUBJECT || 'Đặt lại mật khẩu';
  const appName = process.env.APP_NAME || 'Ứng dụng';
  const greeting = displayName ? `Xin chào ${displayName},` : 'Xin chào,';

  const text = `${greeting}

Bạn vừa yêu cầu đặt lại mật khẩu cho tài khoản ${to}.

Mở link sau (hiệu lực 1 giờ, dùng một lần):
${resetLink}

Nếu bạn không yêu cầu thao tác này, hãy bỏ qua email này.

— ${appName}`;

  await createTransport().sendMail({ from, to, subject, text });
}

/**
 * @param {string} to
 * @param {string} verifyLink
 * @param {string} [displayName]
 */
export async function sendEmailVerificationEmail(to, verifyLink, displayName) {
  if (!smtpConfigured()) {
    const err = new Error('SMTP_NOT_CONFIGURED');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const from = process.env.SMTP_FROM.trim();
  const subject = process.env.SMTP_VERIFY_SUBJECT || 'Xác minh email đăng ký';
  const appName = process.env.APP_NAME || 'Ứng dụng';
  const greeting = displayName ? `Xin chào ${displayName},` : 'Xin chào,';

  const text = `${greeting}

Cảm ơn bạn đã đăng ký tại ${appName}.

Xác minh email bằng link sau (hiệu lực 24 giờ):
${verifyLink}

— ${appName}`;

  await createTransport().sendMail({ from, to, subject, text });
}

export function buildPasswordResetLink(plainToken) {
  const base = appPublicBaseUrl();
  if (!base) {
    throw new Error('APP_PUBLIC_URL_OR_FRONTEND_URL_REQUIRED');
  }
  return `${base}/reset-password?token=${encodeURIComponent(plainToken)}`;
}

export function buildEmailVerifyLink(plainToken) {
  const base = appPublicBaseUrl();
  if (!base) {
    throw new Error('APP_PUBLIC_URL_OR_FRONTEND_URL_REQUIRED');
  }
  return `${base}/verify-email?token=${encodeURIComponent(plainToken)}`;
}

export function isSmtpConfigured() {
  return smtpConfigured();
}
