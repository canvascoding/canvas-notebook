/** Keep the opening and conclusion, inspired by Hermes cron's _clip_to_context_budget. */
export function clipAutomationResultText(input: {
  text: string;
  maxCharacters: number;
  marker: string;
  fits: (text: string, truncated: boolean) => boolean;
}): { text: string; truncated: boolean } | null {
  const text = input.text.trim();
  const limit = Math.max(0, Math.floor(input.maxCharacters));
  if (!limit) return null;

  // A fitting UTF-8 result cannot retain more characters than its byte budget.
  // Only materialize bounded views of very large results, including Unicode pairs.
  const completeCharacters = text.length <= limit * 2 ? Array.from(text) : null;
  if (completeCharacters && completeCharacters.length <= limit && input.fits(text, false)) {
    return { text, truncated: false };
  }
  const head = completeCharacters?.slice(0, limit)
    ?? Array.from(text.slice(0, limit * 2)).slice(0, limit);
  const tail = completeCharacters?.slice(-limit)
    ?? Array.from(text.slice(-limit * 2)).slice(-limit);
  const render = (count: number) => {
    const headCount = Math.ceil(count / 2);
    const tailCount = Math.floor(count / 2);
    return head.slice(0, headCount).join('') + input.marker
      + (tailCount ? tail.slice(-tailCount).join('') : '');
  };
  let low = 0;
  let high = Math.min(limit, completeCharacters ? completeCharacters.length - 1 : limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (input.fits(render(middle), true)) low = middle;
    else high = middle - 1;
  }
  // Both ends must contain source text; a marker alone is not useful context.
  if (low < 2) return null;
  return { text: render(low), truncated: true };
}
