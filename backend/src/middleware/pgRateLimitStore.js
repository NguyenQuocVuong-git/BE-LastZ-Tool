import { pool } from '../config/database.js';

/**
 * Store rate-limit dùng PostgreSQL — đồng bộ giữa nhiều instance (Vercel/serverless).
 */
export class PgRateLimitStore {
  constructor(prefix = 'rl') {
    this.prefix = prefix;
    this.windowMs = 60 * 1000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  key(fullKey) {
    return `${this.prefix}:${fullKey}`.slice(0, 255);
  }

  async increment(fullKey) {
    const k = this.key(fullKey);
    const windowStart = new Date(Math.floor(Date.now() / this.windowMs) * this.windowMs);
    const resetAt = new Date(windowStart.getTime() + this.windowMs);

    const { rows } = await pool.query(
      `INSERT INTO rate_limits (key, hits, reset_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE
           WHEN rate_limits.reset_at <= NOW() THEN 1
           ELSE rate_limits.hits + 1
         END,
         reset_at = CASE
           WHEN rate_limits.reset_at <= NOW() THEN $2
           ELSE rate_limits.reset_at
         END
       RETURNING hits, reset_at`,
      [k, resetAt],
    );

    const row = rows[0];
    const totalHits = row.hits;
    const resetTime = new Date(row.reset_at);

    return {
      totalHits,
      resetTime,
    };
  }

  async decrement(_fullKey) {
    // không cần cho express-rate-limit mặc định
  }

  async resetKey(fullKey) {
    await pool.query(`DELETE FROM rate_limits WHERE key = $1`, [this.key(fullKey)]);
  }
}
