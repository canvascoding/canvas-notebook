export function toMediaUrl(filePath: string) {
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  
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