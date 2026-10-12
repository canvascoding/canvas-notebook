/** Selection affects new model work, never the validity of an existing assessment. */
export const MAX_EMAIL_CLASSIFICATION_LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;

export function isEmailSelectedForClassification(input: {
  inInbox: boolean; dateTimestamp: number | null; list: { isRead?: boolean };
}, initialLookbackDays: number, now: number): boolean {
  if (!input.inInbox) return false;
  if (input.list.isRead === false) return true;
  const days = Math.min(MAX_EMAIL_CLASSIFICATION_LOOKBACK_DAYS, initialLookbackDays);
  return input.dateTimestamp !== null && Number.isSafeInteger(input.dateTimestamp)
    && input.dateTimestamp <= now && input.dateTimestamp >= now - days * DAY_MS;
}

/** Trusted SQL expressions only; values are supplied separately as query parameters. */
export function emailClassificationSelectionSql(alias: 'message' | 'c', now: string, days: string): string {
  return `(${alias}.in_inbox AND (${alias}.list_json->'isRead' = 'false'::jsonb
    OR ${alias}.date_timestamp BETWEEN (${now})::bigint - LEAST(${MAX_EMAIL_CLASSIFICATION_LOOKBACK_DAYS}, (${days})::integer) * ${DAY_MS}::bigint AND (${now})::bigint))`;
}
