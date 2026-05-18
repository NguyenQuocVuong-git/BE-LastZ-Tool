import pg from 'pg';

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === 'production';

function sslConfigFromEnv() {
  const url = process.env.DATABASE_URL || '';
  const strict =
    process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' ||
    process.env.DB_SSL_REJECT_UNAUTHORIZED === '1' ||
    /sslmode=(require|verify-full|verify-ca)/i.test(url);

  if (!strict) {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

const poolConfig = isProduction
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfigFromEnv(),
      max: 20,
      idleTimeoutMillis: 30000,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'tool_backend',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      max: 20,
      idleTimeoutMillis: 30000,
    };

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error', err);
});
