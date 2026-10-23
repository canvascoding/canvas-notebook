/** Lexical document identity only; callers still enforce workspace and IO policy. */
export function isCanonicalWorkspacePath(value: unknown, allowRoot = false): value is string {
  return typeof value === 'string' && value.length <= 4096
    && (value === '' ? allowRoot : !/[\\\u0000-\u001f\u007f]/u.test(value)
      && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));
}

/** The native Markdown cohort uses literal paths, including filename whitespace.
 * Other formats retain their existing alias and publication contracts. */
export function isCanonicalMarkdownWorkspacePath(value: unknown): value is string {
  return isCanonicalWorkspacePath(value) && /\.(?:md|markdown)$/iu.test(value);
}
