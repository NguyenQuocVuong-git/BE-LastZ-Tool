-- Bảo mật: reset mật khẩu / xác minh email (idempotent)

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires_at TIMESTAMPTZ;

-- Tài khoản cũ: coi như đã xác minh email
UPDATE users
SET email_verified_at = COALESCE(email_verified_at, created_at, NOW())
WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS rate_limits (
  key VARCHAR(255) PRIMARY KEY,
  hits INT NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits (reset_at);

-- Session cũ lưu plaintext: vô hiệu để bắt buộc đăng nhập lại (HMAC mới)
UPDATE users SET session_token = NULL WHERE session_token IS NOT NULL;
