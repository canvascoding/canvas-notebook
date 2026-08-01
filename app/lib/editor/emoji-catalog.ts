export type CanvasEmoji = {
  emoji: string;
  keywords: string[];
  label: string;
};

export const CANVAS_EMOJI_CATALOG: CanvasEmoji[] = [
  { emoji: '😀', label: 'Grinning face', keywords: ['happy', 'smile', 'grin'] },
  { emoji: '😄', label: 'Smiling face', keywords: ['happy', 'smile', 'joy'] },
  { emoji: '😂', label: 'Tears of joy', keywords: ['laugh', 'funny', 'lol'] },
  { emoji: '😊', label: 'Warm smile', keywords: ['happy', 'blush', 'thanks'] },
  { emoji: '😍', label: 'Heart eyes', keywords: ['love', 'like', 'heart'] },
  { emoji: '🤔', label: 'Thinking face', keywords: ['think', 'question', 'hmm'] },
  { emoji: '😮', label: 'Surprised face', keywords: ['wow', 'surprise'] },
  { emoji: '😢', label: 'Crying face', keywords: ['sad', 'tear'] },
  { emoji: '😎', label: 'Cool face', keywords: ['cool', 'sunglasses'] },
  { emoji: '🥳', label: 'Party face', keywords: ['party', 'celebrate'] },
  { emoji: '👍', label: 'Thumbs up', keywords: ['yes', 'approve', 'good'] },
  { emoji: '👎', label: 'Thumbs down', keywords: ['no', 'reject', 'bad'] },
  { emoji: '👏', label: 'Clapping hands', keywords: ['applause', 'great'] },
  { emoji: '🙌', label: 'Raised hands', keywords: ['hooray', 'celebrate'] },
  { emoji: '🙏', label: 'Folded hands', keywords: ['please', 'thanks', 'pray'] },
  { emoji: '💪', label: 'Strong arm', keywords: ['strong', 'effort'] },
  { emoji: '👀', label: 'Eyes', keywords: ['look', 'review', 'watch'] },
  { emoji: '🫡', label: 'Saluting face', keywords: ['salute', 'done'] },
  { emoji: '❤️', label: 'Red heart', keywords: ['love', 'heart'] },
  { emoji: '💡', label: 'Light bulb', keywords: ['idea', 'insight'] },
  { emoji: '🔥', label: 'Fire', keywords: ['hot', 'great', 'important'] },
  { emoji: '✨', label: 'Sparkles', keywords: ['new', 'magic', 'shine'] },
  { emoji: '🎉', label: 'Party popper', keywords: ['party', 'celebrate', 'release'] },
  { emoji: '🚀', label: 'Rocket', keywords: ['launch', 'fast', 'ship'] },
  { emoji: '✅', label: 'Check mark', keywords: ['done', 'yes', 'complete'] },
  { emoji: '❌', label: 'Cross mark', keywords: ['no', 'error', 'failed'] },
  { emoji: '⚠️', label: 'Warning', keywords: ['warning', 'caution'] },
  { emoji: 'ℹ️', label: 'Information', keywords: ['info', 'note'] },
  { emoji: '❓', label: 'Question mark', keywords: ['question', 'help'] },
  { emoji: '⭐', label: 'Star', keywords: ['favorite', 'important'] },
  { emoji: '📌', label: 'Pushpin', keywords: ['pin', 'important'] },
  { emoji: '📝', label: 'Memo', keywords: ['note', 'write', 'document'] },
  { emoji: '📎', label: 'Paperclip', keywords: ['attach', 'file'] },
  { emoji: '📅', label: 'Calendar', keywords: ['date', 'schedule'] },
  { emoji: '⏰', label: 'Alarm clock', keywords: ['time', 'deadline'] },
  { emoji: '🔍', label: 'Magnifying glass', keywords: ['search', 'find'] },
  { emoji: '🔒', label: 'Lock', keywords: ['private', 'security'] },
  { emoji: '🔗', label: 'Link', keywords: ['url', 'connection'] },
  { emoji: '🧪', label: 'Test tube', keywords: ['test', 'experiment'] },
  { emoji: '🐛', label: 'Bug', keywords: ['bug', 'issue'] },
  { emoji: '🛠️', label: 'Tools', keywords: ['fix', 'build', 'work'] },
  { emoji: '📈', label: 'Chart increasing', keywords: ['growth', 'chart', 'metric'] },
  { emoji: '💬', label: 'Speech bubble', keywords: ['comment', 'chat'] },
  { emoji: '📣', label: 'Megaphone', keywords: ['announce', 'news'] },
  { emoji: '🌍', label: 'Globe', keywords: ['world', 'global'] },
  { emoji: '🔴', label: 'Red circle', keywords: ['red', 'status', 'blocked'] },
  { emoji: '🟡', label: 'Yellow circle', keywords: ['yellow', 'status', 'pending'] },
  { emoji: '🟢', label: 'Green circle', keywords: ['green', 'status', 'ready'] },
];

export function filterCanvasEmoji(query: string, limit = 48): CanvasEmoji[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return CANVAS_EMOJI_CATALOG
    .filter((item) => !normalizedQuery || [
      item.emoji,
      item.label,
      ...item.keywords,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
    .slice(0, Math.max(0, limit));
}
