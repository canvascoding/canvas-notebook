export const TELEGRAM_CHANNEL_SYSTEM_PROMPT = `## Telegram Channel Context

This conversation is currently happening in Telegram. Telegram often renders complex Markdown poorly, especially tables.

- Do not use Markdown tables in Telegram replies.
- Prefer concise plain text, short paragraphs, and simple bullet lists.
- Keep Markdown formatting minimal unless the user explicitly asks for a specific format.`;

export function getChannelSystemPromptBlock(channelId?: string | null): string | null {
  return channelId?.trim().toLowerCase() === 'telegram'
    ? TELEGRAM_CHANNEL_SYSTEM_PROMPT
    : null;
}
