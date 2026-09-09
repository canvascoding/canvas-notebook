import { boundPiCompactionSummaryInput } from './recovery';

/** Allocate before rendering: section delimiters and each digest survive trimming. */
export function buildPiSummarySourceInput(input: {
  sourceRecords: readonly string[];
  prior: string;
  anchors: string;
  users: string;
  instruction: string;
  maximumCharacters: number;
}): string {
  const sections = [
    { label: 'source_segments', values: input.sourceRecords, weight: 0.55 },
    { label: 'prior_rolling_summary', values: [input.prior], weight: 0.25 },
    { label: 'exact_anchors', values: [input.anchors], weight: 0.15 },
    { label: 'historical_user_excerpts', values: [input.users], weight: 0.05 },
  ].filter((section) => section.values.some(Boolean));
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
  const records = sections.map((section, index) => wrap(section.label, section.values.map((value) => (
    boundPiCompactionSummaryInput(value, Math.floor(budgets[index] / section.values.length))
  )).join('\n\n')));
  const result = [...records, input.instruction].join('\n\n');
  // Fail closed on a model window too small even for framing; never cut tags.
  return result.length <= input.maximumCharacters ? result : '';
}
