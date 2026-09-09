function encodePathSegments(filePath: string): string {
  return filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function mobileHtmlPreviewPath(ticket: string, filePath: string): string {
  return `/api/mobile/v1/files/html-preview/${encodeURIComponent(ticket)}/${encodePathSegments(filePath)}`;
}
