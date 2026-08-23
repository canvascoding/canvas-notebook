export const TODO_ICON_KEYS = [
  'check',
  'eye',
  'approval',
  'message',
  'file',
  'calendar',
  'warning',
  'idea',
  'user',
  'settings',
] as const;

export type TodoIconKey = typeof TODO_ICON_KEYS[number];

export function isTodoIconKey(value: unknown): value is TodoIconKey {
  return typeof value === 'string' && TODO_ICON_KEYS.includes(value as TodoIconKey);
}
