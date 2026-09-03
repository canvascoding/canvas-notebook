/**
 * Keep all pre-existing final line endings. TipTap normally omits them,
 * but a structural empty paragraph can also make the serializer emit extra
 * terminal line endings that are not stable when parsed again.
 */
export function restoreRichMarkdownFinalLineEnding(
  originalBody: string,
  serializedBody: string,
): string {
  const finalLineEnding = originalBody.match(/((?:\r?\n)+)$/u)?.[1];
  const bodyWithoutFinalLineEndings = serializedBody.replace(/(?:\r?\n)+$/u, '');
  return finalLineEnding
    ? `${bodyWithoutFinalLineEndings}${finalLineEnding}`
    : bodyWithoutFinalLineEndings;
}
