export const WORKSPACE_COLOR_OPTIONS = [
  { id: 'blue', value: '#2563EB' },
  { id: 'indigo', value: '#4F46E5' },
  { id: 'violet', value: '#7C3AED' },
  { id: 'magenta', value: '#A21CAF' },
  { id: 'rose', value: '#BE123C' },
  { id: 'orange', value: '#C2410C' },
  { id: 'amber', value: '#A16207' },
  { id: 'emerald', value: '#047857' },
  { id: 'teal', value: '#0F766E' },
  { id: 'slate', value: '#475569' },
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLOR_OPTIONS)[number]['value'];
export type WorkspaceColorId = (typeof WORKSPACE_COLOR_OPTIONS)[number]['id'];

export const DEFAULT_WORKSPACE_COLOR: WorkspaceColor = WORKSPACE_COLOR_OPTIONS[0].value;

const WORKSPACE_COLORS = new Set<string>(WORKSPACE_COLOR_OPTIONS.map((option) => option.value));

export function parseWorkspaceColor(value: unknown): WorkspaceColor | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return WORKSPACE_COLORS.has(normalized) ? normalized as WorkspaceColor : null;
}
