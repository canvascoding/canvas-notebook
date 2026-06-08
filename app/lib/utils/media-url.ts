function encodePathSegments(filePath: string) {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function toWorkspaceMediaUrl(filePath: string) {
  return `/api/media/${encodePathSegments(filePath.replace(/^\/+/, ''))}`;
}

export function toUploadMediaUrl(fileId: string) {
  return `/api/files/${encodeURIComponent(fileId)}`;
}

export function toUploadPreviewUrl(fileId: string, width: number, options: PreviewUrlOptions = {}) {
  const params = new URLSearchParams({
    w: String(width),
  });

  if (options.preset && options.preset !== 'default') {
    params.set('preset', options.preset);
  }

  return `/api/files/${encodeURIComponent(fileId)}/preview?${params.toString()}`;
}

export function toMediaUrl(filePath: string) {
  const encodedPath = encodePathSegments(filePath);
  
  if (filePath.startsWith('studio/')) {
    return `/api/studio/media/${encodedPath}`;
  }

  if (filePath.startsWith('studio-gen-')) {
    return `/api/studio/media/studio/outputs/${encodedPath}`;
  }

  if (filePath.startsWith('user-uploads/studio-references/')) {
    return `/api/studio/media/${encodedPath}`;
  }

  if (
    filePath.startsWith('presets/') ||
    filePath.startsWith('products/') ||
    filePath.startsWith('personas/') ||
    filePath.startsWith('styles/') ||
    filePath.startsWith('references/')
  ) {
    return `/api/studio/media/studio/assets/${encodedPath}`;
  }
  
  // Use API route for media serving (works with Next.js standalone)
  return `/api/media/${encodedPath}`;
}

export function toHtmlPreviewUrl(filePath: string) {
  const encodedPath = encodePathSegments(filePath);

  if (filePath.startsWith('studio/')) {
    return `/api/studio/media/preview/${encodedPath}`;
  }

  if (filePath.startsWith('studio-gen-')) {
    return `/api/studio/media/preview/studio/outputs/${encodedPath}`;
  }

  if (filePath.startsWith('user-uploads/studio-references/')) {
    return `/api/studio/media/preview/${encodedPath}`;
  }

  if (
    filePath.startsWith('presets/') ||
    filePath.startsWith('products/') ||
    filePath.startsWith('personas/') ||
    filePath.startsWith('styles/') ||
    filePath.startsWith('references/')
  ) {
    return `/api/studio/media/preview/studio/assets/${encodedPath}`;
  }

  return `/api/media/preview/${encodedPath}`;
}

interface PreviewUrlOptions {
  preset?: 'default' | 'mini';
}

export function toPreviewUrl(filePath: string, width: number, options: PreviewUrlOptions = {}) {
  const params = new URLSearchParams({
    path: filePath,
    w: String(width),
  });

  if (options.preset && options.preset !== 'default') {
    params.set('preset', options.preset);
  }

  // Use relative URLs so they work in both dev and production
  const suffix = `/api/files/preview?${params.toString()}`;
  return suffix;
}
