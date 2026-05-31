export type DefaultTodoCategoryKey = 'todo' | 'review' | 'approval' | 'automation';

export type DefaultTodoCategoryDefinition = {
  key: DefaultTodoCategoryKey;
  name: string;
  color: string;
  icon: string;
  aliases: string[];
};

export const DEFAULT_TODO_CATEGORY_NAME = 'To-do';

export const DEFAULT_TODO_CATEGORIES: readonly DefaultTodoCategoryDefinition[] = [
  {
    key: 'todo',
    name: DEFAULT_TODO_CATEGORY_NAME,
    color: '#3b82f6',
    icon: 'check-square',
    aliases: ['todo', 'to-do', 'to do', 'aufgabe', 'aufgaben'],
  },
  {
    key: 'review',
    name: 'Review',
    color: '#f59e0b',
    icon: 'search-check',
    aliases: ['review', 'check', 'checks', 'pruefen', 'prüfen', 'prufen', 'prüfung', 'pruefung'],
  },
  {
    key: 'approval',
    name: 'Approval',
    color: '#10b981',
    icon: 'badge-check',
    aliases: ['approval', 'approve', 'freigabe', 'freigaben'],
  },
  {
    key: 'automation',
    name: 'Automation',
    color: '#8b5cf6',
    icon: 'workflow',
    aliases: ['automation', 'automatisierung', 'automatisierungen'],
  },
] as const;

type CategoryIdentity = {
  name?: string | null;
  icon?: string | null;
};

function normalizeCategoryText(value: string) {
  return value
    .trim()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function getDefaultTodoCategoryDefinition(key: DefaultTodoCategoryKey) {
  return DEFAULT_TODO_CATEGORIES.find((category) => category.key === key) ?? null;
}

export function getDefaultTodoCategoryKey(category: CategoryIdentity | string | null | undefined): DefaultTodoCategoryKey | null {
  if (!category) return null;

  const name = typeof category === 'string' ? category : category.name;
  if (!name) return null;
  const normalizedName = normalizeCategoryText(name);

  return DEFAULT_TODO_CATEGORIES.find((definition) => (
    normalizeCategoryText(definition.name) === normalizedName
    || definition.aliases.some((alias) => normalizeCategoryText(alias) === normalizedName)
  ))?.key ?? null;
}

export function resolveDefaultTodoCategoryName(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = getDefaultTodoCategoryKey(name);
  return key ? getDefaultTodoCategoryDefinition(key)?.name ?? null : name;
}
