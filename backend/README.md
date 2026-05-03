# Backend quản lý license (Node.js + Express + PostgreSQL)

Hệ thống xác thực tài khoản thời hạn cho tool desktop: đăng ký `pending`, thanh toán thủ công qua Telegram, kích hoạt `active`, session đơn (`session_token` 32 byte), không JWT.

## Yêu cầu

- Node.js **>= 18**
- PostgreSQL **>= 13** (cần extension `pgcrypto` cho `gen_random_uuid()`)

## 1. Cài đặt

```bash
cd backend
npm install
```

## 2. Tạo database và chạy migration

Tạo database (ví dụ `tool_backend`), sau đó:

```bash
psql -h localhost -U postgres -d tool_backend -f src/migrations/001_init.sql
```

Hoặc từ `psql`:

```sql
\c tool_backend
\i src/migrations/001_init.sql
```

Migration dùng `IF NOT EXISTS` / `CREATE TYPE ... EXCEPTION` nên chạy lại an toàn.

## 3. Cấu hình môi trường

```bash
copy .env.example .env
```

Điền `DB_*`, `TELEGRAM_*`, `BANK_*`, `SERVER_URL` (HTTPS, không dấu `/` cuối). `BANK_BIN` là mã ngân hàng theo VietQR (MB thường là `970422`).

## 4. Tạo tài khoản admin

1. Đăng ký user thường qua `POST /auth/register` (hoặc chèn trực tiếp) với email thật.
2. Cấp quyền admin và (tuỳ chọn) đặt mật khẩu bằng bcrypt.

Tạo hash mật khẩu (ví dụ mật khẩu `ChangeMe123!`):

```bash
node --input-type=module -e "import bcrypt from 'bcryptjs'; console.log(await bcrypt.hash('ChangeMe123!', 12))"
```

Gán vào DB:

```sql
UPDATE users
SET role = 'admin',
    password_hash = '<paste_bcrypt_hash_here>',
    status = 'active',
    expires_at = NOW() + INTERVAL '3650 days'
WHERE email = 'admin@example.com';
```

Admin gọi API với header `x-session-token` sau khi `POST /auth/login`.

## 5. Chạy server

```bash
npm start
```

Kiểm tra: `GET http://localhost:3000/health`

Khi khởi động, nếu đủ `TELEGRAM_BOT_TOKEN`, `SERVER_URL`, `TELEGRAM_WEBHOOK_SECRET`, server gọi `setWebHook` trỏ tới:

`{SERVER_URL}/webhook/telegram/{TELEGRAM_WEBHOOK_SECRET}`

Đảm bảo domain công khai có HTTPS và reverse proxy chuyển tiếp đúng tới `PORT`.

## API chính (tóm tắt)

| Phương thức | Đường dẫn | Ghi chú |
|-------------|-----------|---------|
| POST | `/auth/register` | Email + password, `pending` |
| POST | `/auth/login` | Trả `session_token`, `expires_at`, `remaining_*` |
| GET | `/auth/verify` | Header `x-session-token`, hot path cho tool |
| GET | `/auth/me` | Cần session |
| GET | `/payment/plans` | Gói public |
| POST | `/payment/check-coupon` | Session + `plan_id`, `code` |
| POST | `/payment/request` | Tạo đơn + `vietqr_url`, notify Telegram |
| * | `/admin/*` | Session user `role=admin`; không phải admin → **404** |
| POST | `/webhook/telegram/:secret` | Webhook Telegram |

## JSON lỗi

Hầu hết response: `{ success, code?, message, data? }`. Rate limit trả `code: RATE_LIMITED`.

## Ghi chú bảo mật

- Giới hạn tần suất theo bảng trong prompt (`express-rate-limit`, không Redis).
- Một user chỉ một `session_token`; đăng nhập mới vô hiệu token cũ (`SESSION_REPLACED` khi verify).
- Thời gian hết hạn do server (`new Date()`), không tin client.
