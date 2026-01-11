export function toMediaUrl(filePath: string) {
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  // Use relative URLs so they work in both dev and production
  const suffix = `/media/${encodedPath}`;
  return suffix;
}

export function toPreviewUrl(filePath: string, width: number) {
  // Use relative URLs so they work in both dev and production
  const suffix = `/api/files/preview?path=${encodeURIComponent(filePath)}&w=${width}`;
  return suffix;
}
