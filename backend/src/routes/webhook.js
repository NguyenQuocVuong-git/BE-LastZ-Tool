import { Router } from 'express';
import { bot, telegramWebhookSecret, telegramChatId } from '../config/telegram.js';
import { registerTelegramCallbacks, formatPaymentMessage } from '../services/telegramService.js';

const router = Router();

registerTelegramCallbacks(bot);

/**
 * POST /webhook/test-message
 * Dùng để test việc sinh text cho Telegram và tự push sang Telegram
 */
router.post('/test-message', async (req, res) => {
  try {
    const text = formatPaymentMessage(req.body);
    
    // Tạo bàn phím ảo (fake callback_data 32 ký tự) giống y hệt khi chạy thật
    const dummyCompact = '00000000000000000000000000000000';
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Xác nhận đã nhận tiền', callback_data: `1a${dummyCompact}` },
          { text: '❌ Từ chối', callback_data: `1r${dummyCompact}` },
        ],
      ],
    };

    // Push vào tele nếu bot và chatId đã được set
    if (bot && telegramChatId) {
      await bot.sendMessage(telegramChatId, text, { reply_markup: keyboard });
    }

    return res.json({ success: true, text, pushedToTelegram: !!(bot && telegramChatId) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

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
