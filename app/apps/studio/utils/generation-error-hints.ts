const GEMINI_BLOCKED_PROMPT_HINT =
  'Hinweis: Das kann am Bild oder Prompt liegen. Gemini blockiert Bearbeiten oder Imitieren von Celebrities und bekannten Personen. Nutze eigene, freigegebene Personen oder formuliere den Prompt neutraler.';

export function getStudioGenerationErrorHint(message?: string | null): string | null {
  if (!message) return null;

  const normalized = message.toLowerCase();
  const noImageReturned = normalized.includes('no image was returned by gemini');
  const blockedFeedback = normalized.includes('promptfeedback=other');

  return noImageReturned && blockedFeedback ? GEMINI_BLOCKED_PROMPT_HINT : null;
}
