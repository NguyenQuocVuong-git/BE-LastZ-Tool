import { Router } from 'express';
import { bot, telegramWebhookSecret } from '../config/telegram.js';
import { verifySePayWebhook, processWebhook as processSePayWebhook } from '../services/sepayService.js';

const router = Router();

/**
 * POST /webhook/sepay
 * Nhận webhook từ SePay.
 */
router.post('/sepay', async (req, res) => {
  if (!verifySePayWebhook(req)) {
    return res.sendStatus(401);
  }

  // SePay expects a successful JSON response.
  // Trả 200 ngay lập tức để tránh timeout; xử lý async bên dưới.
  res.status(200).json({ success: true });

  // Xử lý bất đồng bộ sau khi đã trả 200 cho SePay (tránh timeout).
  Promise.resolve()
    .then(() => processSePayWebhook(req.body))
    .catch((e) => {
      console.error('[SePay] Lỗi xử lý webhook:', e);
    });
});

/**
 * POST /webhook/telegram/:secret
 * Giữ lại webhook Telegram đơn giản: chỉ verify secret và forward update nếu có bot.
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

