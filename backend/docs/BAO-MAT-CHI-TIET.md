# Bảo mật backend — đánh giá & khắc phục

Tài liệu mô tả các rủi ro đã xử lý (từ mục **2** trở đi trong báo cáo audit), cách triển khai, và việc cần làm sau khi deploy.

> **Lưu ý:** Mục **1** (download công khai) **không** thay đổi — file tool có lớp bảo mật riêng bên trong.

---

## Tóm tắt thay đổi

| # | Vấn đề | Mức độ | Trạng thái |
|---|--------|--------|------------|
| 1 | Download public | — | Không sửa (theo yêu cầu) |
| 2 | Webhook SePay bỏ verify khi sandbox | Cao | Đã sửa |
| 3 | CORS `*` | Trung bình | Đã sửa |
| 4 | Session token plaintext trong DB | Trung bình | Đã sửa |
| 5 | Quên MK gửi mật khẩu qua email | Trung bình | Đã sửa |
| 6 | Rate limit chỉ trong RAM | Trung bình | Đã sửa (PostgreSQL) |
| 7 | SSL `rejectUnauthorized: false` | Trung bình | Đã cấu hình hóa |
| 8 | Thiếu security headers | Thấp | Đã thêm `helmet` |
| 9 | Không xác minh email khi đăng ký | Thấp–TB | Đã sửa |
| 10 | `.env.example` lộ credential mẫu | Thấp | Đã làm sạch |

**SQL injection:** Không thay đổi — project vốn dùng parameterized queries (`$1`, `$2`).

---

## Triển khai bắt buộc

### 1. Chạy migration

```bash
psql -h localhost -U postgres -d tool_backend -f src/migrations/002_security_tokens.sql
```

Migration này:

- Thêm cột reset mật khẩu / xác minh email trên `users`
- Đánh dấu user **cũ** là đã xác minh email (`email_verified_at = created_at`)
- Tạo bảng `rate_limits` cho rate limit đa instance
- **Xóa mọi `session_token` cũ** — user phải **đăng nhập lại** sau deploy

### 2. Biến môi trường production

Sao chép từ `.env.example` và điền:

| Biến | Bắt buộc prod | Mô tả |
|------|----------------|--------|
| `SESSION_SECRET` | Có | ≥ 32 ký tự ngẫu nhiên; HMAC session & token reset |
| `IS_PRODUCTION` | `true` | Bật kiểm tra SePay Apikey |
| `SEPAY_API_KEY` | Có | Khớp header webhook SePay |
| `ALLOWED_ORIGINS` | Có | VD: `https://app.example.com` |
| `APP_PUBLIC_URL` | Có (nếu dùng email) | Base URL FE cho link reset / verify |
| `DB_SSL_REJECT_UNAUTHORIZED` | Khuyến nghị `true` | Khi `DATABASE_URL` dùng SSL |

**Không** đặt `ALLOW_UNVERIFIED_SEPAY_WEBHOOK=true` trên production.

### 3. Cài dependency

```bash
npm install
```

Đã thêm `helmet` vào `package.json`.

---

## Chi tiết từng hạng mục

### 2. Webhook SePay

**Trước:** `IS_PRODUCTION=false` → mọi request `POST /webhook/sepay` được chấp nhận, có thể kích hoạt license giả.

**Sau:**

- Luôn yêu cầu `SEPAY_API_KEY` đã cấu hình
- Chỉ bỏ qua verify khi **cả hai**: không phải production **và** `ALLOW_UNVERIFIED_SEPAY_WEBHOOK=true` (dev local)
- So sánh Apikey bằng `crypto.timingSafeEqual` (chống timing attack)

**File:** `src/services/sepayService.js`

---

### 3. CORS

**Trước:** `Access-Control-Allow-Origin: *`

**Sau:**

- Production (`NODE_ENV=production` hoặc `IS_PRODUCTION=true`): chỉ origin trong `ALLOWED_ORIGINS`
- Development: thêm `localhost:3000`, `5173`, …; nếu chưa cấu hình `ALLOWED_ORIGINS` vẫn linh hoạt cho Postman/curl

**File:** `src/middleware/cors.js`, `app.js`

---

### 4. Session token trong database

**Trước:** Lưu token 64 hex thô trong `users.session_token` — rò DB = chiếm phiên.

**Sau:**

- Client vẫn nhận/gửi token thô qua `x-session-token`
- DB lưu `HMAC-SHA256(token, SESSION_SECRET)`
- Sau migration: session cũ bị xóa → đăng nhập lại

**File:** `src/utils/tokenHash.js`, `src/middleware/auth.js`, `src/routes/auth.js`

---

### 5. Quên mật khẩu

**Trước:** Gửi mật khẩu mới plaintext trong email.

**Sau:**

1. `POST /auth/forgot-password` — gửi **link** một lần (hết hạn 1 giờ)
2. `POST /auth/reset-password` — body `{ "token": "...", "new_password": "..." }`
3. Token lưu hash trong `password_reset_token_hash`

Link dạng: `{APP_PUBLIC_URL}/reset-password?token=...`

**Frontend:** Cần trang `/reset-password` đọc `token` từ query và gọi API.

**File:** `src/routes/auth.js`, `src/services/emailService.js`

---

### 6. Rate limit đa instance (Vercel)

**Trước:** `express-rate-limit` + `Map` trong RAM — mỗi instance có bộ đếm riêng.

**Sau:** Khi `NODE_ENV=production` hoặc `IS_PRODUCTION=true` (hoặc `USE_PG_RATE_LIMIT=true`), dùng bảng `rate_limits` qua `PgRateLimitStore`.

**File:** `src/middleware/pgRateLimitStore.js`, `src/middleware/rateLimiter.js`

---

### 7. SSL PostgreSQL

**Trước:** Luôn `rejectUnauthorized: false`.

**Sau:**

- Mặc định dev/hosted linh hoạt: `false`
- Bật strict khi `DB_SSL_REJECT_UNAUTHORIZED=true` **hoặ** `DATABASE_URL` chứa `sslmode=require|verify-full|verify-ca`

**File:** `src/config/database.js`

---

### 8. Security headers (Helmet)

**Sau:** `helmet()` trên toàn app; tắt CSP/COEP để tránh phá JSON API và download file.

**File:** `app.js`

---

### 9. Xác minh email

**Luồng mới:**

1. Đăng ký → nếu có SMTP + `APP_PUBLIC_URL`: gửi mail link verify (24h)
2. Không SMTP → tự `email_verified_at = NOW()` (dev)
3. `POST /auth/verify-email` — `{ "token": "..." }`
4. `POST /auth/resend-verification` — cần session
5. Các route **thanh toán** yêu cầu `requireEmailVerified` → `403 EMAIL_NOT_VERIFIED` nếu chưa verify

User cũ (trước migration): coi như đã verify.

**File:** `src/middleware/auth.js`, `src/routes/auth.js`, `src/routes/payment.js`, migration `002`

---

### 10. `.env.example`

Đã thay credential giả bằng placeholder; bổ sung biến mới (`ALLOWED_ORIGINS`, `APP_PUBLIC_URL`, …).

---

## API mới / thay đổi

| Method | Path | Ghi chú |
|--------|------|---------|
| POST | `/auth/reset-password` | `{ token, new_password }` |
| POST | `/auth/verify-email` | `{ token }` hoặc `?token=` |
| POST | `/auth/resend-verification` | Header session |
| POST | `/auth/forgot-password` | Không còn đổi MK trực tiếp — chỉ gửi link |

Response `login` / `me` / `register` có thêm `email_verified` (boolean).

---

## Checklist production

- [ ] Chạy `002_security_tokens.sql`
- [ ] `SESSION_SECRET` mạnh, không commit `.env`
- [ ] `IS_PRODUCTION=true`, `SEPAY_API_KEY` đúng
- [ ] `ALLOWED_ORIGINS` khớp domain FE
- [ ] `APP_PUBLIC_URL` + SMTP cho reset/verify
- [ ] `DB_SSL_REJECT_UNAUTHORIZED=true` (nếu CA đầy đủ)
- [ ] Không bật `ALLOW_UNVERIFIED_SEPAY_WEBHOOK`
- [ ] FE: trang reset-password & verify-email
- [ ] Thông báo user đăng nhập lại sau deploy (session cũ bị xóa)
- [ ] `npm audit` định kỳ

---

## Rủi ro còn lại (chấp nhận / theo dõi)

| Hạng mục | Ghi chú |
|----------|---------|
| Download public | Cố ý giữ — bảo vệ trong file tool |
| Admin chỉ bằng `role` trong DB | Cần bảo vệ quyền SQL / quy trình tạo admin |
| Không Redis riêng | Rate limit dùng PostgreSQL — đủ cho quy mô vừa |
| Session vẫn gửi qua header | Cần HTTPS; không log token |
| Brute force token reset | Đã rate limit IP; token 64 hex entropy cao |

---

## Cấu trúc file liên quan

```
backend/
├── app.js                          # helmet + cors
├── docs/BAO-MAT-CHI-TIET.md        # tài liệu này
├── src/
│   ├── config/database.js          # SSL
│   ├── middleware/
│   │   ├── auth.js                 # session hash, requireEmailVerified
│   │   ├── cors.js
│   │   ├── pgRateLimitStore.js
│   │   └── rateLimiter.js
│   ├── migrations/002_security_tokens.sql
│   ├── routes/auth.js              # reset/verify email
│   ├── routes/payment.js           # requireEmailVerified
│   ├── services/
│   │   ├── emailService.js
│   │   └── sepayService.js
│   └── utils/
│       ├── appUrl.js
│       └── tokenHash.js
└── .env.example
```

---

## Khắc phục sự cố

**Mọi user bị logout sau deploy**  
→ Đúng thiết kế: migration xóa `session_token` cũ. Đăng nhập lại.

**`403 CORS_FORBIDDEN`**  
→ Thêm origin FE vào `ALLOWED_ORIGINS`.

**`403 EMAIL_NOT_VERIFIED` khi thanh toán**  
→ Gọi `POST /auth/verify-email` hoặc `POST /auth/resend-verification`.

**Webhook SePay 401**  
→ Kiểm tra header `Authorization: Apikey <SEPAY_API_KEY>` và `IS_PRODUCTION=true`.

**Rate limit lỗi 500**  
→ Chưa chạy migration `002` hoặc bảng `rate_limits` thiếu.

**Link email không mở được**  
→ Đặt `APP_PUBLIC_URL` trỏ đúng frontend (HTTPS).

---

*Tài liệu cập nhật sau đợt hardening bảo mật — tháng 5/2026.*
