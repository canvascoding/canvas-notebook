import { getExtension } from './path-utils';

export const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'log', 'js', 'jsx', 'ts', 'tsx', 'json', 'css', 'scss', 'html', 'htm',
  'yml', 'yaml', 'md', 'mdx', 'markdown', 'env', 'gitignore', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'php', 'sql', 'toml', 'excalidraw',
]);
export function documentCapabilities(path: string) {
  const extension = getExtension(path);
  return {
    text: extension === '' || TEXT_FILE_EXTENSIONS.has(extension),
    office: ['docx', 'xlsx', 'csv', 'xls', 'pptx'].includes(extension),
    html: ['html', 'htm'].includes(extension),
    scene: extension === 'excalidraw',
  };
}

export function withDocumentRevision(url: string, revision?: string | null): string {
  if (!revision) return url;
  const [base, fragment] = url.split('#', 2);
  return `${base}${base.includes('?') ? '&' : '?'}revision=${encodeURIComponent(revision)}${fragment === undefined ? '' : `#${fragment}`}`;
}
