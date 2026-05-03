import { Router } from 'express';
import { pool } from '../config/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { adminPostLimiter } from '../middleware/rateLimiter.js';
import * as userService from '../services/userService.js';

const router = Router();

router.use(requireAuth, requireAdmin);

/**
 * GET /admin/stats
 * Thống kê nhanh user + đơn chờ.
 */
router.get('/stats', async (req, res) => {
  try {
    const users = await pool.query(
      `SELECT status::text, COUNT(*)::int AS c FROM users GROUP BY status`,
    );
    const pay = await pool.query(
      `SELECT COUNT(*)::int AS c FROM pending_payments WHERE status = 'waiting'`,
    );
    const map = { active: 0, pending: 0, expired: 0, banned: 0 };
    for (const row of users.rows) {
      map[row.status] = row.c;
    }
    return res.json({
      success: true,
      data: {
        ...map,
        waiting_payments: pay.rows[0]?.c ?? 0,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * GET /admin/users
 * Danh sách user (filter status, phân trang).
 */
router.get('/users', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const params = [];
    let where = 'WHERE 1=1';
    if (status && ['pending', 'active', 'expired', 'banned'].includes(status)) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }

    const countQ = await pool.query(
      `SELECT COUNT(*)::int AS c FROM users ${where}`,
      params,
    );
    const total = countQ.rows[0].c;

    params.push(limit, offset);
    const list = await pool.query(
      `SELECT id, email, role, status, plan_id, activated_at, expires_at,
              ip_registered, last_login_at, last_login_ip, created_at
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return res.json({
      success: true,
      data: {
        items: list.rows,
        page,
        limit,
        total,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * GET /admin/users/:id
 * Chi tiết + lịch sử kích hoạt + đơn hàng.
 */
router.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy user.' });
    }
    const logs = await pool.query(
      `SELECT * FROM activation_logs WHERE user_id = $1 ORDER BY activated_at DESC`,
      [id],
    );
    const payments = await pool.query(
      `SELECT * FROM pending_payments WHERE user_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    return res.json({
      success: true,
      data: { user, activation_logs: logs.rows, payments: payments.rows },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * POST /admin/users/:id/activate
 * Kích hoạt / gia hạn thủ công (không qua Telegram).
 */
router.post('/users/:id/activate', adminPostLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const planId = Number(req.body?.plan_id);
    const note = req.body?.note != null ? String(req.body.note) : null;
    if (!planId) {
      return res.status(400).json({ success: false, message: 'Thiếu plan_id.' });
    }

    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    const u = rows[0];
    if (!u) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy user.' });
    }
    if (u.status === 'banned') {
      return res.status(400).json({ success: false, message: 'User đang bị ban.' });
    }

    const result = await userService.activateUser({
      userId: id,
      planId,
      activatedBy: 'admin',
      note,
    });
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.message });
    }

    await pool.query(
      `INSERT INTO admin_logs (action, target_id, detail) VALUES ($1, $2, $3)`,
      [
        'manual_activate',
        id,
        JSON.stringify({ plan_id: planId, note, expires_at: result.expires_at?.toISOString?.() }),
      ],
    );

    return res.json({
      success: true,
      message: 'Đã kích hoạt / gia hạn.',
      data: { expires_at: result.expires_at },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * POST /admin/users/:id/ban
 */
router.post('/users/:id/ban', adminPostLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const reason = req.body?.reason != null ? String(req.body.reason) : '';

    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy user.' });
    }

    await pool.query(
      `UPDATE users SET status = 'banned', session_token = NULL WHERE id = $1`,
      [id],
    );
    await pool.query(
      `INSERT INTO admin_logs (action, target_id, detail) VALUES ($1, $2, $3)`,
      ['ban', id, JSON.stringify({ reason })],
    );

    return res.json({ success: true, message: 'Đã ban tài khoản.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * POST /admin/users/:id/unban
 * Trả về trạng thái pending.
 */
router.post('/users/:id/unban', adminPostLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy user.' });
    }

    await pool.query(
      `UPDATE users SET status = 'pending', failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [id],
    );
    await pool.query(
      `INSERT INTO admin_logs (action, target_id, detail) VALUES ($1, $2, $3)`,
      ['unban', id, JSON.stringify({ to_status: 'pending' })],
    );

    return res.json({ success: true, message: 'Đã bỏ ban — trạng thái pending.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * GET /admin/plans
 */
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM plans ORDER BY duration_days`);
    return res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * POST /admin/plans
 */
router.post('/plans', adminPostLimiter, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const duration_days = Number(req.body?.duration_days);
    const price = Number(req.body?.price);
    const is_active = req.body?.is_active !== false;

    if (!name || !duration_days || Number.isNaN(price)) {
      return res.status(400).json({ success: false, message: 'name, duration_days, price là bắt buộc.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO plans (name, duration_days, price, is_active) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, duration_days, price, is_active],
    );
    await pool.query(
      `INSERT INTO admin_logs (action, target_id, detail) VALUES ($1, $2, $3)`,
      ['plan_create', null, JSON.stringify(rows[0])],
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * PUT /admin/plans/:id
 */
router.put('/plans/:id', adminPostLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const fields = [];
    const params = [];
    let i = 1;

    if (req.body.name != null) {
      fields.push(`name = $${i++}`);
      params.push(String(req.body.name).trim());
    }
    if (req.body.duration_days != null) {
      fields.push(`duration_days = $${i++}`);
      params.push(Number(req.body.duration_days));
    }
    if (req.body.price != null) {
      fields.push(`price = $${i++}`);
      params.push(Number(req.body.price));
    }
    if (req.body.is_active != null) {
      fields.push(`is_active = $${i++}`);
      params.push(Boolean(req.body.is_active));
    }

    if (!fields.length) {
      return res.status(400).json({ success: false, message: 'Không có trường cập nhật.' });
    }
    params.push(id);
    const q = `UPDATE plans SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`;
    const { rows } = await pool.query(q, params);
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy gói.' });
    }
    await pool.query(
      `INSERT INTO admin_logs (action, target_id, detail) VALUES ($1, $2, $3)`,
      ['plan_update', null, JSON.stringify(rows[0])],
    );
    return res.json({ success: true, data: rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * GET /admin/coupons
 */
router.get('/coupons', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *, (used_count >= max_uses OR (expires_at IS NOT NULL AND expires_at <= NOW())) AS depleted
       FROM discount_codes ORDER BY id DESC`,
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * POST /admin/coupons
 */
router.post('/coupons', adminPostLimiter, async (req, res) => {
  try {
    const code = String(req.body?.code || '')
      .trim()
      .toUpperCase();
    const discount_pct = Number(req.body?.discount_pct);
    const max_uses = Number(req.body?.max_uses);
    let expires_at = null;
    if (req.body.expires_at) {
      const d = new Date(req.body.expires_at);
      if (!Number.isNaN(d.getTime())) expires_at = d;
    }

    if (!code || Number.isNaN(discount_pct) || Number.isNaN(max_uses)) {
      return res.status(400).json({
        success: false,
        message: 'code, discount_pct, max_uses là bắt buộc.',
      });
    }
    if (discount_pct < 1 || discount_pct > 100) {
      return res.status(400).json({ success: false, message: 'discount_pct từ 1 đến 100.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO discount_codes (code, discount_pct, max_uses, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [code, discount_pct, max_uses, expires_at],
    );
    await pool.query(
      `INSERT INTO admin_logs (action, target_id, detail) VALUES ($1, $2, $3)`,
      ['coupon_create', null, JSON.stringify(rows[0])],
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ success: false, message: 'Mã đã tồn tại.' });
    }
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * PUT /admin/coupons/:id
 */
router.put('/coupons/:id', adminPostLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const fields = [];
    const params = [];
    let i = 1;

    if (req.body.max_uses != null) {
      fields.push(`max_uses = $${i++}`);
      params.push(Number(req.body.max_uses));
    }
    if (req.body.is_active != null) {
      fields.push(`is_active = $${i++}`);
      params.push(Boolean(req.body.is_active));
    }
    if (req.body.expires_at !== undefined) {
      fields.push(`expires_at = $${i++}`);
      if (req.body.expires_at === null || req.body.expires_at === '') {
        params.push(null);
      } else {
        const d = new Date(req.body.expires_at);
        params.push(Number.isNaN(d.getTime()) ? null : d);
      }
    }

    if (!fields.length) {
      return res.status(400).json({ success: false, message: 'Không có trường cập nhật.' });
    }
    params.push(id);
    const q = `UPDATE discount_codes SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`;
    const { rows } = await pool.query(q, params);
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy mã.' });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

/**
 * GET /admin/coupons/:id/usages
 */
router.get('/coupons/:id/usages', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT du.*, u.email
       FROM discount_usages du
       JOIN users u ON u.id = du.user_id
       WHERE du.discount_code_id = $1
       ORDER BY du.used_at DESC`,
      [id],
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Lỗi máy chủ.' });
  }
});

export default router;
