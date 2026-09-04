import type { MemoryScopeType } from './contract';

export type MemoryDisplayLocale = 'de' | 'en';

export const CANONICAL_MEMORY_CATEGORIES = [
  'profile',
  'preferences',
  'communication',
  'interests',
  'tech-stack',
  'recent-work',
  'area',
  'context',
  'decisions',
  'conventions',
  'brand',
  'agent-context',
] as const;

export type CanonicalMemoryCategory = (typeof CANONICAL_MEMORY_CATEGORIES)[number];

const USER_CATEGORIES = new Set<CanonicalMemoryCategory>([
  'profile', 'preferences', 'communication', 'interests', 'tech-stack', 'recent-work', 'area', 'context',
]);

function normalizeCategory(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64) || 'context';
}

/** Maps free-form model categories into a deliberately small, stable taxonomy. */
export function canonicalMemoryCategory(scopeType: MemoryScopeType, value?: string): CanonicalMemoryCategory {
  const normalized = normalizeCategory(value);
  if (scopeType === 'agent') return 'agent-context';
  if (scopeType === 'user') {
    if (USER_CATEGORIES.has(normalized as CanonicalMemoryCategory)) return normalized as CanonicalMemoryCategory;
    if (/communicat|language|response|tone|formal|writing/u.test(normalized)) return 'communication';
    if (/prefer|timezone|format|workflow|habit/u.test(normalized)) return 'preferences';
    if (/interest|hobby|topic/u.test(normalized)) return 'interests';
    if (/tech|stack|software|tool|framework|platform/u.test(normalized)) return 'tech-stack';
    if (/work|project|business|company|brand|provider|contractor|client/u.test(normalized)) return 'recent-work';
    if (/profile|identity|personal|role|contact|bio/u.test(normalized)) return 'profile';
    return 'area';
  }
  if (/brand|visual|design|voice|tone/u.test(normalized)) return 'brand';
  if (/decision|approved|choice|resolution/u.test(normalized)) return 'decisions';
  if (/convention|standard|style|terminology|protocol|policy|guideline|rule/u.test(normalized)) return 'conventions';
  if (/profile|company|business|organization|organisation|structure|provider|contractor|team/u.test(normalized)) return 'profile';
  return 'context';
}

const LABELS: Record<CanonicalMemoryCategory, Record<MemoryDisplayLocale, string>> = {
  profile: { de: 'Profil', en: 'Profile' },
  preferences: { de: 'Präferenzen', en: 'Preferences' },
  communication: { de: 'Kommunikation', en: 'Communication' },
  interests: { de: 'Interessen', en: 'Interests' },
  'tech-stack': { de: 'Technologie', en: 'Technology' },
  'recent-work': { de: 'Aktuelle Arbeit', en: 'Recent work' },
  area: { de: 'Themenbereich', en: 'Area' },
  context: { de: 'Kontext', en: 'Context' },
  decisions: { de: 'Entscheidungen', en: 'Decisions' },
  conventions: { de: 'Standards', en: 'Conventions' },
  brand: { de: 'Marke', en: 'Brand' },
  'agent-context': { de: 'Agentenkontext', en: 'Agent context' },
};

const DESCRIPTIONS: Record<CanonicalMemoryCategory, Record<MemoryDisplayLocale, string>> = {
  profile: { de: 'Dauerhafte Fakten zu Identität, Rolle und Struktur.', en: 'Durable facts about identity, role, and structure.' },
  preferences: { de: 'Persönliche Arbeitsweisen und wiederkehrende Präferenzen.', en: 'Personal working habits and recurring preferences.' },
  communication: { de: 'Sprache, Ton und gewünschte Antwortweise.', en: 'Language, tone, and preferred response style.' },
  interests: { de: 'Langfristige Interessen und relevante Themen.', en: 'Long-term interests and relevant topics.' },
  'tech-stack': { de: 'Bevorzugte Technologien, Werkzeuge und Plattformen.', en: 'Preferred technologies, tools, and platforms.' },
  'recent-work': { de: 'Aktuelle Projekte, Kunden und beruflicher Kontext.', en: 'Current projects, clients, and work context.' },
  area: { de: 'Weitere dauerhafte persönliche Zusammenhänge.', en: 'Other durable personal context.' },
  context: { de: 'Gemeinsamer, dauerhaft relevanter Kontext.', en: 'Shared context that remains relevant over time.' },
  decisions: { de: 'Bestätigte Entscheidungen und ihre dauerhafte Wirkung.', en: 'Confirmed decisions and their lasting effect.' },
  conventions: { de: 'Verbindliche Standards, Regeln und Terminologie.', en: 'Shared standards, rules, and terminology.' },
  brand: { de: 'Markenstruktur, Tonalität und Gestaltungsgrundsätze.', en: 'Brand structure, voice, and design principles.' },
  'agent-context': { de: 'Dauerhafter Kontext für diesen Agenten.', en: 'Durable context for this agent.' },
};

function asCanonicalCategory(category: string): CanonicalMemoryCategory | null {
  return (CANONICAL_MEMORY_CATEGORIES as readonly string[]).includes(category)
    ? category as CanonicalMemoryCategory
    : null;
}

export function memoryCategoryLabel(category: string, locale: MemoryDisplayLocale): string {
  const canonical = asCanonicalCategory(category);
  if (canonical) return LABELS[canonical][locale];
  return category.split('-').filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ') || LABELS.context[locale];
}

export function memoryCategoryDescription(category: string, locale: MemoryDisplayLocale): string {
  const canonical = asCanonicalCategory(category) ?? 'context';
  return DESCRIPTIONS[canonical][locale];
}

export function memoryReviewLanguageInstruction(locale: MemoryDisplayLocale): string {
  return locale === 'de'
    ? 'Write every memory content value in German, matching the user account language. Preserve proper names and established technical terms.'
    : 'Write every memory content value in English, matching the user account language. Preserve proper names and established technical terms.';
}
