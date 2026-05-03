import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.warn('TELEGRAM_BOT_TOKEN is not set — Telegram features disabled until configured.');
}

/** Bot ở chế độ webhook: không bật polling. */
export const bot = token
  ? new TelegramBot(token, { polling: false })
  : null;

export const telegramChatId = process.env.TELEGRAM_CHAT_ID
  ? String(process.env.TELEGRAM_CHAT_ID)
  : null;

export const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
