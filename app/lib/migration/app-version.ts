import 'server-only';

import packageJson from '@/package.json';

export function getCurrentAppVersion(): string {
  return packageJson.version || '0.0.0';
}
