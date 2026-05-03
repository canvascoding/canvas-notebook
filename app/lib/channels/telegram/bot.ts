import { Bot } from 'grammy';

export function createTelegramBot(token: string): Bot {
  const bot = new Bot(token);
  bot.catch((err) => console.error('[telegram] bot error:', err));
  return bot;
}