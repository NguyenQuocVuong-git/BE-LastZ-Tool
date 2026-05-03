import { Router } from 'express';
import { bot, telegramWebhookSecret } from '../config/telegram.js';
import { registerTelegramCallbacks } from '../services/telegramService.js';

const router = Router();

registerTelegramCallbacks(bot);

/**
 * POST /webhook/telegram/:secret
 * Nhận update từ Telegram (webhook). Secret phải khớp TELEGRAM_WEBHOOK_SECRET.
 */
router.post('/telegram/:secret', (req, res) => {
  if (!bot) {
    return res.status(503).json({ success: false, message: 'Telegram chưa cấu hình.' });
  }
  const { secret } = req.params;
  if (!telegramWebhookSecret || secret !== telegramWebhookSecret) {
    return res.status(404).json({ success: false, message: 'Not Found' });
  }
  try {
    bot.processUpdate(req.body);
    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(500);
  }
});

export default router;
