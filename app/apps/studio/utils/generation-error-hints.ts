export function getStudioGenerationErrorHint(message?: string | null): 'geminiBlockedPrompt' | null {
  if (!message) return null;

  const normalized = message.toLowerCase();
  const noImageReturned = normalized.includes('no image was returned by gemini');
  const blockedFeedback = normalized.includes('promptfeedback=other');

  return noImageReturned && blockedFeedback ? 'geminiBlockedPrompt' : null;
}
