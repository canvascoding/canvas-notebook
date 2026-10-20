import 'server-only';
import path from 'node:path';
import { redactPortableRuntimeConfig } from './secret-export-policy';
import { getMigrationDataRoot } from './paths';

export function portableDatabaseProviderConfig(id: string, raw: string | null): string | null {
  if (raw === null) return null;
  const definition: unknown = JSON.parse(raw);
  const wrapped = JSON.stringify({ providers: { [id]: definition } });
  const root = getMigrationDataRoot();
  const safe = redactPortableRuntimeConfig(wrapped, path.join(root, 'settings/providers.json'), root);
  if (!safe) throw new Error('Cannot safely export database provider configuration.');
  return JSON.stringify(JSON.parse(safe).providers[id]);
}
