/** A safe ASCII fallback plus the original Unicode name for HTTP downloads. */
export function fileContentDisposition(fileName: string, disposition: 'inline' | 'attachment' = 'attachment'): string {
  const safeName = fileName.toWellFormed().replace(/[\x00-\x1F\x7F"\\/]/g, '_') || 'download';
  const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_');
  const encodedName = encodeURIComponent(safeName)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}
