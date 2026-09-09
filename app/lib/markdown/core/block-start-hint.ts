/**
 * Search only literal candidates before applying an unchanged line-anchored
 * block hint. The pattern must begin with this exact, case-sensitive prefix,
 * optionally preceded by up to `indent` ASCII spaces, and use multiline `^`.
 *
 * Marked asks about every remaining paragraph suffix. A regex search scans all
 * that prose again; indexOf can skip directly to the few possible block starts.
 * Sticky matching retains the original anchors, whitespace and line endings.
 * No document text or parse-lifecycle state is retained between calls.
 */
export function createBlockStartHint(pattern: RegExp, prefix: string, indent = 0): (source: string) => number {
  const candidatePattern = new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, '') + 'y');
  return (source) => {
    for (let candidate = source.indexOf(prefix); candidate >= 0; candidate = source.indexOf(prefix, candidate + 1)) {
      let start = candidate;
      while (candidate - start < indent && source[start - 1] === ' ') start--;
      candidatePattern.lastIndex = start;
      if (candidatePattern.test(source)) return start;
    }
    return -1;
  };
}
