export const HUMAN_ACTIVITY_INTERVAL_MS = 60_000;

export function shouldReportHumanActivity(input: {
  visible: boolean;
  trusted: boolean;
  repeating: boolean;
  now: number;
  lastAttemptAt: number;
}): boolean {
  return input.visible && input.trusted && !input.repeating
    && input.now - input.lastAttemptAt >= HUMAN_ACTIVITY_INTERVAL_MS;
}
