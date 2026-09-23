import { boundPiCompactionSummaryInput } from './recovery';

/** Escape before allocating budgets so reference text cannot close prompt tags. */
export function escapePiSummaryReference(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Allocate before rendering: section delimiters and each digest survive trimming. */
export type PiSummarySourceInput = Readonly<{
  sourceRecords: readonly string[];
  /** Callers that sampled already-escaped records must not escape them again. */
  sourceRecordsAreEscaped?: boolean;
  prior: string;
  anchors: string;
  users: string;
  instruction: string;
  maximumCharacters: number;
}>;

type PiSummarySection = Readonly<{
  label: string;
  values: readonly string[];
  weight: number;
}>;

function buildSections(input: PiSummarySourceInput): readonly PiSummarySection[] {
  const sections = [
    { label: 'source_segments', values: input.sourceRecords, weight: 0.55 },
    { label: 'prior_rolling_summary', values: [input.prior], weight: 0.25 },
    { label: 'exact_anchors', values: [input.anchors], weight: 0.15 },
    { label: 'historical_user_excerpts', values: [input.users], weight: 0.05 },
  ].filter((section) => section.values.some(Boolean)).map((section) => ({
    ...section,
    values: section.values.map((value) => (
      section.label === 'source_segments' && input.sourceRecordsAreEscaped
        ? value
        : escapePiSummaryReference(value)
    )),
  }));
  return Object.freeze(sections);
}

function allocateSectionBudgets(input: PiSummarySourceInput, sections: readonly PiSummarySection[]): {
  budgets: number[];
  overhead: number;
} {
  const wrap = (label: string, text: string) => `<untrusted_${label}>\n${text}\n</untrusted_${label}>`;
  const overhead = input.instruction.length + 2 + sections.reduce((sum, section) => (
    sum + wrap(section.label, '').length + 2 + section.values.length * 2
  ), 0);
  const available = Math.max(0, input.maximumCharacters - overhead);
  const needs = sections.map((section) => section.values.reduce((sum, value) => sum + value.length, 0));
  const budgets = sections.map((section, index) => Math.min(needs[index], Math.floor(available * section.weight)));
  let remaining = available - budgets.reduce((sum, budget) => sum + budget, 0);
  for (let index = 0; index < sections.length; index++) {
    const extra = Math.min(remaining, needs[index] - budgets[index]);
    budgets[index] += extra;
    remaining -= extra;
  }
  return { budgets, overhead };
}

/**
 * Reserve the source section before sampling records. The caller can then
 * sample one rendered record block to this exact allocation without a second
 * per-record truncation that would lose the newest record or gap markers.
 */
export function getPiSummarySourceSectionBudget(input: Omit<PiSummarySourceInput, 'sourceRecords' | 'sourceRecordsAreEscaped'>): number {
  const sections = buildSections({
    ...input,
    // A deliberately full source makes the allocation conservative while
    // retaining the same one-record framing used by the V2 caller.
    sourceRecords: ['x'.repeat(Math.max(1, input.maximumCharacters))],
    sourceRecordsAreEscaped: true,
  });
  const { budgets } = allocateSectionBudgets({
    ...input,
    sourceRecords: ['x'.repeat(Math.max(1, input.maximumCharacters))],
    sourceRecordsAreEscaped: true,
  }, sections);
  const sourceIndex = sections.findIndex((section) => section.label === 'source_segments');
  return sourceIndex < 0 ? 0 : budgets[sourceIndex];
}

export function buildPiSummarySourceInput(input: PiSummarySourceInput): string {
  const sections = buildSections(input);
  const { budgets } = allocateSectionBudgets(input, sections);
  const wrap = (label: string, text: string) => `<untrusted_${label}>\n${text}\n</untrusted_${label}>`;
  const records = sections.map((section, index) => wrap(section.label, section.values.map((value) => {
    const budget = Math.floor(budgets[index] / section.values.length);
    // The truncation marker itself may exceed a very small section allocation.
    return boundPiCompactionSummaryInput(value, budget).slice(0, budget);
  }).join('\n\n')));
  const result = [...records, input.instruction].join('\n\n');
  // Fail closed on a model window too small even for framing; never cut tags.
  return result.length <= input.maximumCharacters ? result : '';
}
