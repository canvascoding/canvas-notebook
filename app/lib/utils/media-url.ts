function encodePathSegments(filePath: string) {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export interface MediaUrlOptions {
  workspaceId?: string | null;
}

interface PreviewUrlOptions extends MediaUrlOptions {
  preset?: 'default' | 'mini';
}

function withInferredStudioWorkspace(filePath: string, options: MediaUrlOptions): MediaUrlOptions {
  if (options.workspaceId?.trim()) return options;
  const match = /^\/?studio\/organizations\/[^/]+\/workspaces\/([^/]+)(?:\/|$)/u.exec(filePath);
  return match?.[1] ? { ...options, workspaceId: match[1] } : options;
}

function withWorkspaceId(url: string, options: MediaUrlOptions = {}) {
  const workspaceId = options.workspaceId?.trim();
  if (!workspaceId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}workspaceId=${encodeURIComponent(workspaceId)}`;
}

function workspacePreviewRoutePrefix(options: MediaUrlOptions = {}) {
  const workspaceId = options.workspaceId?.trim();
  if (!workspaceId) return '/api/media/preview';
  return `/api/media/preview/__workspace/${encodeURIComponent(workspaceId)}`;
}

export function toWorkspaceMediaUrl(filePath: string, options: MediaUrlOptions = {}) {
  return withWorkspaceId(`/api/media/${encodePathSegments(filePath.replace(/^\/+/, ''))}`, options);
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

export function toMediaUrl(filePath: string, options: MediaUrlOptions = {}) {
  const encodedPath = encodePathSegments(filePath);
  const scopedOptions = withInferredStudioWorkspace(filePath, options);
  
  if (filePath.startsWith('studio/')) {
    return withWorkspaceId(`/api/studio/media/${encodedPath}`, scopedOptions);
  }

  if (filePath.startsWith('studio-gen-')) {
    return withWorkspaceId(`/api/studio/media/studio/outputs/${encodedPath}`, options);
  }

  if (filePath.startsWith('user-uploads/studio-references/')) {
    return withWorkspaceId(`/api/studio/media/${encodedPath}`, options);
  }

  if (
    filePath.startsWith('presets/') ||
    filePath.startsWith('products/') ||
    filePath.startsWith('personas/') ||
    filePath.startsWith('styles/') ||
    filePath.startsWith('references/')
  ) {
    return withWorkspaceId(`/api/studio/media/studio/assets/${encodedPath}`, options);
  }
  
  // Use API route for media serving (works with Next.js standalone)
  return withWorkspaceId(`/api/media/${encodedPath}`, options);
}

export function toHtmlPreviewUrl(filePath: string, options: MediaUrlOptions = {}) {
  const encodedPath = encodePathSegments(filePath);
  const scopedOptions = withInferredStudioWorkspace(filePath, options);

  if (filePath.startsWith('studio/')) {
    return withWorkspaceId(`/api/studio/media/preview/${encodedPath}`, scopedOptions);
  }

  if (filePath.startsWith('studio-gen-')) {
    return withWorkspaceId(`/api/studio/media/preview/studio/outputs/${encodedPath}`, options);
  }

  if (filePath.startsWith('user-uploads/studio-references/')) {
    return withWorkspaceId(`/api/studio/media/preview/${encodedPath}`, options);
  }

  if (
    filePath.startsWith('presets/') ||
    filePath.startsWith('products/') ||
    filePath.startsWith('personas/') ||
    filePath.startsWith('styles/') ||
    filePath.startsWith('references/')
  ) {
    return withWorkspaceId(`/api/studio/media/preview/studio/assets/${encodedPath}`, options);
  }

  return `${workspacePreviewRoutePrefix(options)}/${encodedPath}`;
}

export function toPreviewUrl(filePath: string, width: number, options: PreviewUrlOptions = {}) {
  const scopedOptions = withInferredStudioWorkspace(filePath, options);
  const params = new URLSearchParams({
    path: filePath,
    w: String(width),
  });

  if (options.preset && options.preset !== 'default') {
    params.set('preset', options.preset);
  }

  if (scopedOptions.workspaceId?.trim()) {
    params.set('workspaceId', scopedOptions.workspaceId.trim());
  }

  // Use relative URLs so they work in both dev and production
  const suffix = `/api/files/preview?${params.toString()}`;
  return suffix;
}
