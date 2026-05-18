import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import authRoutes from './src/routes/auth.js';
import paymentRoutes from './src/routes/payment.js';
import adminRoutes from './src/routes/admin.js';
import webhookRoutes from './src/routes/webhook.js';
import downloadRoutes from './src/routes/download.js';
import { bot, telegramWebhookSecret } from './src/config/telegram.js';
import { corsMiddleware } from './src/middleware/cors.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SERVER_URL = (process.env.SERVER_URL || '').replace(/\/$/, '');

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(express.json({ limit: '256kb' }));
app.use(corsMiddleware);

app.get('/health', (req, res) => {
  res.json({ success: true, data: { ok: true } });
});

app.use('/auth', authRoutes);
app.use('/payment', paymentRoutes);
app.use('/admin', adminRoutes);
app.use('/webhook', webhookRoutes);
app.use('/download', downloadRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Lỗi máy chủ.',
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not Found' });
});

async function setupTelegramWebhook() {
  if (bot && SERVER_URL && telegramWebhookSecret) {
    const hook = `${SERVER_URL}/webhook/telegram/${telegramWebhookSecret}`;
    try {
      await bot.setWebHook(hook);
      console.log('Telegram webhook set:', hook);
    } catch (e) {
      console.error('Failed to set Telegram webhook', e.message);
    }
  } else if (!bot) {
    console.warn('Telegram bot not configured.');
  } else {
    console.warn('SERVER_URL or TELEGRAM_WEBHOOK_SECRET missing — skip setWebHook.');
  }
}

// Vercel: export app làm serverless handler (@vercel/node)
export default app;

// Chạy local: node app.js / npm start
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    await setupTelegramWebhook();
  });
} else {
  setupTelegramWebhook().catch((e) =>
    console.error('Failed to set Telegram webhook on cold start', e.message)
  );
}
