import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { CanvasCliConfig, CommandResult, CommandRunner, RuntimeContext } from './types';

const MANAGED_MARKER = '# Managed by Canvas Notebook';

export interface CaddyTarget {
  baseUrl: string;
  domain: string;
  publicDomain: boolean;
}

export interface CaddyStatus {
  configuredBaseUrl: string;
  domain: string;
  publicDomain: boolean;
  installed: boolean;
  serviceActive: boolean;
  caddyfile: string;
  caddyfileExists: boolean;
  caddyfileManaged: boolean;
  legacyConfigExists: boolean;
  inSync: boolean;
  issues: string[];
  error: string | null;
}

export interface CaddyApplyResult extends CaddyStatus {
  success: boolean;
  changed: boolean;
  reloaded: boolean;
  restarted: boolean;
  skipped: boolean;
  skipReason: 'no_public_domain' | 'caddy_not_installed' | null;
}

interface CaddyPaths {
  caddyfile: string;
  legacyConfig: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Caddy operation failed.';
}

function validateHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.endsWith('.') ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) {
    throw new Error(`Invalid Caddy domain: ${value || '(empty)'}`);
  }
  return hostname;
}

export function resolveCaddyTarget(config: CanvasCliConfig): CaddyTarget {
  const configuredUrl = String(config.env.BETTER_AUTH_BASE_URL || '').trim()
    || String(config.env.BASE_URL || '').trim()
    || (config.domain ? `https://${config.domain}` : '');
  if (!configuredUrl) return { baseUrl: '', domain: '', publicDomain: false };
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error('Configured Caddy base URL must be a valid http:// or https:// URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Configured Caddy base URL must be a valid http:// or https:// URL.');
  }
  const domain = validateHostname(parsed.hostname);
  const publicDomain = domain !== 'localhost' && !domain.endsWith('.localhost') && net.isIP(domain) === 0;
  return { baseUrl: configuredUrl, domain, publicDomain };
}

export function renderCaddyfile(domain: string, hostPort: number): string {
  validateHostname(domain);
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error(`Invalid Caddy upstream port: ${hostPort}`);
  return `${MANAGED_MARKER}\n${domain} {\n\treverse_proxy localhost:${hostPort} {\n\t\theader_up X-Forwarded-Port 443\n\t}\n}\n`;
}

export function isCaddyCommand(command: string): boolean {
  return command === 'caddy' || command === 'caddy-reload' || command === 'caddy-fix';
}

function activeStatements(content: string): string {
  return content
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+#.*$/u, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function recognizedCanvasSite(content: string, domain: string): boolean {
  if (content.includes(MANAGED_MARKER)) return true;
  const normalized = activeStatements(content);
  const domainPattern = escapeRegex(domain);
  return new RegExp(
    `^${domainPattern} \\{ reverse_proxy localhost:[0-9]{1,5}(?: \\{ header_up X-Forwarded-Port 443 \\})? \\}$`,
    'u',
  ).test(normalized);
}

function knownDefaultSite(content: string): boolean {
  return /^:80 \{ root \* \/usr\/share\/caddy file_server \}$/u.test(activeStatements(content));
}

function contentIssues(content: string, domain: string, hostPort: number): string[] {
  if (content.trim() === renderCaddyfile(domain, hostPort).trim()) return [];
  const issues: string[] = [];
  const normalized = activeStatements(content);
  if (knownDefaultSite(content)) issues.push('default_site_present');
  if (!normalized.startsWith(`${domain} {`)) issues.push('domain_mismatch');
  if (!normalized.includes(`reverse_proxy localhost:${hostPort}`)) issues.push('upstream_mismatch');
  if (!normalized.includes('header_up X-Forwarded-Port 443')) issues.push('missing_forwarded_port');
  if (!recognizedCanvasSite(content, domain) && !knownDefaultSite(content)) issues.push('unmanaged_caddyfile');
  return [...new Set(issues)];
}

export class CaddyManager {
  private readonly testRoot: string | null;
  private readonly paths: CaddyPaths;

  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.testRoot = env.CANVAS_CADDY_TEST_ROOT ? path.resolve(env.CANVAS_CADDY_TEST_ROOT) : null;
    this.paths = this.testRoot
      ? {
        caddyfile: path.join(this.testRoot, 'Caddyfile'),
        legacyConfig: path.join(this.testRoot, 'conf.d', 'canvas-notebook.caddy'),
      }
      : {
        caddyfile: '/etc/caddy/Caddyfile',
        legacyConfig: '/etc/caddy/conf.d/canvas-notebook.caddy',
      };
  }

  caddyfilePath(): string {
    return this.paths.caddyfile;
  }

  private assertLinux(): void {
    if (this.context.platform !== 'linux') {
      throw new Error('Caddy management is only supported on Linux. No host changes were made.');
    }
  }

  private async assertTestRoot(): Promise<void> {
    if (!this.testRoot) return;
    const info = await fs.lstat(this.testRoot);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid) {
      throw new Error('CANVAS_CADDY_TEST_ROOT must be an existing, user-owned directory.');
    }
  }

  private async lstatOptional(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
    return fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  }

  private async pathExists(filePath: string): Promise<boolean> {
    return (await this.lstatOptional(filePath)) !== null;
  }

  private async readOptionalRegular(filePath: string, label: string): Promise<string | null> {
    const info = await this.lstatOptional(filePath);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe ${label} path: ${filePath}`);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (this.testRoot || (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
      const result = await this.runRoot('cat', [filePath]);
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `Unable to read ${label}: ${filePath}`);
      }
      return result.stdout;
    }
  }

  private async safeRun(command: string, args: string[]): Promise<CommandResult> {
    try {
      return await this.runner.run(command, args);
    } catch (error) {
      return { status: 127, stdout: '', stderr: message(error) };
    }
  }

  private async runRoot(command: string, args: string[]): Promise<CommandResult> {
    const useSudo = !this.testRoot && typeof process.getuid === 'function' && process.getuid() !== 0;
    return useSudo ? this.safeRun('sudo', [command, ...args]) : this.safeRun(command, args);
  }

  private async runRootOrThrow(command: string, args: string[]): Promise<CommandResult> {
    const result = await this.runRoot(command, args);
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed with status ${result.status}`);
    }
    return result;
  }

  private async removeFile(filePath: string): Promise<void> {
    if (!await this.pathExists(filePath)) return;
    if (this.testRoot) await fs.rm(filePath);
    else await this.runRootOrThrow('rm', ['-f', filePath]);
  }

  private async renameFile(source: string, destination: string): Promise<void> {
    if (this.testRoot) await fs.rename(source, destination);
    else await this.runRootOrThrow('mv', ['-f', source, destination]);
  }

  private async atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
    const existing = await this.lstatOptional(filePath);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Unsafe managed Caddy path: ${filePath}`);
    if (this.testRoot) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.canvas-notebook.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
      try {
        await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
        await fs.chmod(temporary, mode);
        await fs.rename(temporary, filePath);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      return;
    }
    const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-caddy-'));
    const localFile = path.join(localDirectory, 'Caddyfile');
    const rootTemporary = `${filePath}.canvas-notebook.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(localFile, content, { encoding: 'utf8', mode: 0o600 });
      await this.runRootOrThrow('mkdir', ['-p', path.dirname(filePath)]);
      await this.runRootOrThrow('install', ['-m', mode.toString(8), localFile, rootTemporary]);
      await this.runRootOrThrow('mv', ['-f', rootTemporary, filePath]);
    } finally {
      await this.runRoot('rm', ['-f', rootTemporary]);
      await fs.rm(localDirectory, { recursive: true, force: true });
    }
  }

  private async caddyInstalled(): Promise<boolean> {
    return (await this.safeRun('caddy', ['version'])).status === 0;
  }

  private async serviceActive(): Promise<boolean> {
    return (await this.safeRun('systemctl', ['is-active', 'caddy'])).status === 0;
  }

  private async validateCandidate(content: string): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-caddy-validate-'));
    const candidate = path.join(directory, 'Caddyfile');
    try {
      await fs.writeFile(candidate, content, { encoding: 'utf8', mode: 0o600 });
      const result = await this.runRoot('caddy', ['validate', '--config', candidate]);
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || 'Caddyfile validation failed.');
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  private async reloadService(): Promise<{ reloaded: boolean; restarted: boolean }> {
    const reload = await this.runRoot('systemctl', ['reload', 'caddy']);
    if (reload.status === 0) return { reloaded: true, restarted: false };
    const restart = await this.runRoot('systemctl', ['restart', 'caddy']);
    if (restart.status === 0) return { reloaded: false, restarted: true };
    const detail = restart.stderr.trim() || reload.stderr.trim() || 'systemctl reload and restart failed.';
    throw new Error(detail);
  }

  async displayContent(): Promise<string | null> {
    this.assertLinux();
    await this.assertTestRoot();
    return this.readOptionalRegular(this.paths.caddyfile, 'Caddyfile');
  }

  async status(config: CanvasCliConfig, preferredError: string | null = null): Promise<CaddyStatus> {
    this.assertLinux();
    let target: CaddyTarget = { baseUrl: '', domain: '', publicDomain: false };
    let installed = false;
    let serviceActive = false;
    let caddyfileExists = false;
    let caddyfileManaged = false;
    let legacyConfigExists = false;
    let inSync = false;
    const issues: string[] = [];
    let error = preferredError;
    try {
      await this.assertTestRoot();
      target = resolveCaddyTarget(config);
      installed = await this.caddyInstalled();
      serviceActive = installed && await this.serviceActive();
      const content = await this.readOptionalRegular(this.paths.caddyfile, 'Caddyfile');
      caddyfileExists = content !== null;
      const legacy = await this.readOptionalRegular(this.paths.legacyConfig, 'legacy Canvas Caddy config');
      legacyConfigExists = legacy !== null;
      if (!target.publicDomain) {
        issues.push('no_public_domain');
        if (legacyConfigExists) issues.push('legacy_config_present');
        inSync = !legacyConfigExists;
      } else {
        if (!installed) issues.push('caddy_not_installed');
        if (!serviceActive && installed) issues.push('service_inactive');
        if (!content) issues.push('caddyfile_missing');
        else {
          caddyfileManaged = recognizedCanvasSite(content, target.domain);
          issues.push(...contentIssues(content, target.domain, config.hostPort));
        }
        if (legacyConfigExists) issues.push('legacy_config_present');
        inSync = Boolean(content) && contentIssues(content || '', target.domain, config.hostPort).length === 0 && !legacyConfigExists;
      }
    } catch (statusError) {
      error ??= message(statusError);
      issues.push('status_unavailable');
    }
    return {
      configuredBaseUrl: target.baseUrl,
      domain: target.domain,
      publicDomain: target.publicDomain,
      installed,
      serviceActive,
      caddyfile: this.paths.caddyfile,
      caddyfileExists,
      caddyfileManaged,
      legacyConfigExists,
      inSync: inSync && !error,
      issues: [...new Set(issues)],
      error,
    };
  }

  async apply(config: CanvasCliConfig, options: { repair: boolean }): Promise<CaddyApplyResult> {
    this.assertLinux();
    await this.assertTestRoot();
    const target = resolveCaddyTarget(config);
    if (!target.publicDomain) {
      return {
        ...await this.status(config),
        success: true,
        changed: false,
        reloaded: false,
        restarted: false,
        skipped: true,
        skipReason: 'no_public_domain',
      };
    }
    if (!await this.caddyInstalled()) {
      return {
        ...await this.status(config),
        success: true,
        changed: false,
        reloaded: false,
        restarted: false,
        skipped: true,
        skipReason: 'caddy_not_installed',
      };
    }

    const current = await this.readOptionalRegular(this.paths.caddyfile, 'Caddyfile');
    const legacy = await this.readOptionalRegular(this.paths.legacyConfig, 'legacy Canvas Caddy config');
    const recognized = current === null || recognizedCanvasSite(current, target.domain);
    const repairableDefault = current !== null && options.repair && knownDefaultSite(current);
    if (!recognized && !repairableDefault) {
      throw new Error(`Refusing to overwrite unmanaged Caddyfile: ${this.paths.caddyfile}`);
    }
    const desired = renderCaddyfile(target.domain, config.hostPort);
    await this.validateCandidate(desired);

    const currentMode = Number((await this.lstatOptional(this.paths.caddyfile))?.mode || 0o644) & 0o777;
    const changed = current !== desired || (options.repair && legacy !== null);
    const legacyBackup = `${this.paths.legacyConfig}.canvas-backup.${crypto.randomBytes(8).toString('hex')}`;
    let legacyMoved = false;
    try {
      if (current !== desired) await this.atomicWrite(this.paths.caddyfile, desired, currentMode || 0o644);
      if (options.repair && legacy !== null) {
        await this.renameFile(this.paths.legacyConfig, legacyBackup);
        legacyMoved = true;
      }
      const service = await this.reloadService();
      if (legacyMoved) await this.removeFile(legacyBackup);
      return {
        ...await this.status(config),
        success: true,
        changed,
        ...service,
        skipped: false,
        skipReason: null,
      };
    } catch (error) {
      if (current === null) await this.removeFile(this.paths.caddyfile).catch(() => undefined);
      else await this.atomicWrite(this.paths.caddyfile, current, currentMode || 0o644).catch(() => undefined);
      if (legacyMoved && await this.pathExists(legacyBackup)) {
        await this.renameFile(legacyBackup, this.paths.legacyConfig).catch(() => undefined);
      }
      await this.reloadService().catch(() => undefined);
      throw error;
    }
  }
}
