import type { DockerManager } from './docker';
import type { CanvasCliConfig } from './types';

export interface AdminCredentials {
  email: string;
  name: string;
  password: string;
}

export function validateAdminCredentials(input: AdminCredentials): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 320) throw new Error('Enter a valid email.');
  if (!input.name.trim() || input.name.length > 256) throw new Error('Name must be between 1 and 256 characters.');
  if (input.password.length < 8 || input.password.length > 128 || /[\r\n]/u.test(input.password)) throw new Error('Password must be between 8 and 128 characters without line breaks.');
}

export async function resetAdminCredentials(docker: DockerManager, config: CanvasCliConfig, input: AdminCredentials): Promise<void> {
  validateAdminCredentials(input);
  const containerId = await docker.containerId(config);
  if (!containerId) throw new Error('Canvas Notebook container is not running.');
  await docker.dockerOrThrow([
    'exec', '-i', containerId, 'node', 'scripts/bootstrap-admin.js',
    '--email', input.email, '--name', input.name, '--password-stdin',
  ], { stdin: `${input.password}\n`, stdio: 'pipe', timeoutMs: 30_000 });
}
