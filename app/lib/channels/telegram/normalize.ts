const TELEGRAM_MAX_LENGTH = 4000;

export function markdownToTelegramHtml(markdown: string): string {
  let html = markdown;

  html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return html;
}

export function chunkTelegramMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = -1;

    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paragraphBreak > maxLength * 0.3) {
      splitIndex = paragraphBreak + 2;
    }

    if (splitIndex === -1) {
      const lineBreak = remaining.lastIndexOf('\n', maxLength);
      if (lineBreak > maxLength * 0.3) {
        splitIndex = lineBreak + 1;
      }
    }

    if (splitIndex === -1) {
      const sentenceEnd = Math.max(
        remaining.lastIndexOf('. ', maxLength),
        remaining.lastIndexOf('! ', maxLength),
        remaining.lastIndexOf('? ', maxLength),
      );
      if (sentenceEnd > maxLength * 0.3) {
        splitIndex = sentenceEnd + 2;
      }
    }

    if (splitIndex === -1) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks;
}