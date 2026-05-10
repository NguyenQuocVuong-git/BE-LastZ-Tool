-- Idempotent: chạy lại nhiều lần an toàn
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('pending', 'active', 'expired', 'banned');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('waiting', 'confirmed', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  duration_days INT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(10) DEFAULT 'user',
  status user_status DEFAULT 'pending',
  plan_id INT REFERENCES plans (id),
  activated_at TIMESTAMP,
  expires_at TIMESTAMP,
  session_token VARCHAR(64),
  failed_login_attempts INT DEFAULT 0,
  locked_until TIMESTAMP,
  ip_registered VARCHAR(45),
  last_login_at TIMESTAMP,
  last_login_ip VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);

CREATE TABLE IF NOT EXISTS discount_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  discount_pct INT NOT NULL,
  max_uses INT NOT NULL,
  used_count INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users (id),
  plan_id INT REFERENCES plans (id),
  discount_code_id INT REFERENCES discount_codes (id),
  transfer_code VARCHAR(100) UNIQUE NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  discount_amount DECIMAL(10, 2) DEFAULT 0,
  final_amount DECIMAL(10, 2) NOT NULL,
  status payment_status DEFAULT 'waiting',
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS discount_usages (
  id SERIAL PRIMARY KEY,
  discount_code_id INT NOT NULL REFERENCES discount_codes (id),
  user_id UUID NOT NULL REFERENCES users (id),
  payment_id UUID REFERENCES pending_payments (id),
  original_amount DECIMAL(10, 2) NOT NULL,
  discount_amount DECIMAL(10, 2) NOT NULL,
  final_amount DECIMAL(10, 2) NOT NULL,
  used_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (discount_code_id, user_id)
);

CREATE TABLE IF NOT EXISTS sepay_transactions (
  id               SERIAL PRIMARY KEY,
  transaction_id   VARCHAR(100) UNIQUE NOT NULL,
  transfer_code    VARCHAR(100),
  amount           DECIMAL(10,2),
  payment_id       UUID REFERENCES pending_payments(id),
  matched          BOOLEAN DEFAULT false,
  raw_payload      JSONB,
  processed_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activation_logs (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  plan_id INT NOT NULL REFERENCES plans (id),
  activated_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  activated_by VARCHAR(20) DEFAULT 'telegram',
  note TEXT
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id SERIAL PRIMARY KEY,
  action VARCHAR(100) NOT NULL,
  target_id UUID,
  detail JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Dữ liệu mặc định gói (idempotent theo duration_days + price)
INSERT INTO plans (name, duration_days, price, is_active)
SELECT '7 ngày', 7, 50000.00, true
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE duration_days = 7 AND price = 50000.00);

INSERT INTO plans (name, duration_days, price, is_active)
SELECT '30 ngày', 30, 200000.00, true
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE duration_days = 30 AND price = 200000.00);

INSERT INTO plans (name, duration_days, price, is_active)
SELECT '90 ngày', 90, 500000.00, true
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE duration_days = 90 AND price = 500000.00);
