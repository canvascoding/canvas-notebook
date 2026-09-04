import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  SYSTEM_UPDATE_CONTRACT_VERSION,
  SYSTEM_UPDATE_ERROR_CODES,
  SYSTEM_UPDATE_OPERATION_STATUSES,
  SYSTEM_UPDATE_STAGES,
  isTerminalSystemUpdateStatus,
  validateSystemUpdateEvent,
  type SystemUpdateErrorCode,
  type SystemUpdateEvent,
  type SystemUpdateOperation,
  type SystemUpdateOperationStatus,
  type SystemUpdateStage,
} from './systemUpdateContract';

export const STANDALONE_UPDATE_MAX_OPERATIONS = 20;
export const STANDALONE_UPDATE_MAX_JOURNAL_BYTES = 10 * 1024 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u;
const PINNED_IMAGE_PATTERN = /^.{1,440}@sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function parseOperation(input: unknown): SystemUpdateOperation {
  if (!isRecord(input) || input.contractVersion !== SYSTEM_UPDATE_CONTRACT_VERSION ||
    typeof input.operationId !== 'string' || !UUID_PATTERN.test(input.operationId) ||
    !isMember(SYSTEM_UPDATE_OPERATION_STATUSES, input.status) || !isMember(SYSTEM_UPDATE_STAGES, input.stage) ||
    typeof input.targetVersion !== 'string' || !VERSION_PATTERN.test(input.targetVersion) ||
    typeof input.targetImageRef !== 'string' || !PINNED_IMAGE_PATTERN.test(input.targetImageRef) ||
    (input.currentVersion !== null && (typeof input.currentVersion !== 'string' || !VERSION_PATTERN.test(input.currentVersion))) ||
    (input.startedAt !== null && !isTimestamp(input.startedAt)) || !isTimestamp(input.updatedAt) ||
    (input.completedAt !== null && !isTimestamp(input.completedAt)) || typeof input.rolledBack !== 'boolean' ||
    (input.errorCode !== null && !isMember(SYSTEM_UPDATE_ERROR_CODES, input.errorCode)) ||
    (input.error !== null && (typeof input.error !== 'string' || input.error.length > 2048)) ||
    !Number.isSafeInteger(input.lastSequence) || Number(input.lastSequence) < 0) {
    throw new Error('Stored update operation is invalid.');
  }
  return {
    contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
    operationId: input.operationId,
    status: input.status,
    stage: input.stage,
    targetVersion: input.targetVersion,
    targetImageRef: input.targetImageRef,
    currentVersion: input.currentVersion as string | null,
    startedAt: input.startedAt as string | null,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt as string | null,
    rolledBack: input.rolledBack,
    errorCode: input.errorCode as SystemUpdateErrorCode | null,
    error: input.error as string | null,
    lastSequence: Number(input.lastSequence),
  };
}

function redactJournalMessage(value: string): string {
  return value
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/giu, '[redacted-database-url]')
    .replace(/\b(password|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\0\r\n]+/gu, ' ')
    .trim()
    .slice(0, 2048) || 'Update state changed.';
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRegularOrMissing(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Unsafe update journal path: ${filePath}`);
}

export class StandaloneUpdateJournal {
  readonly root: string;
  private readonly operationsDirectory: string;
  private readonly eventsDirectory: string;
  private readonly currentPath: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    if (this.root === path.parse(this.root).root) throw new Error('Update journal root must not be a filesystem root.');
    this.operationsDirectory = path.join(this.root, 'operations');
    this.eventsDirectory = path.join(this.root, 'events');
    this.currentPath = path.join(this.root, 'current-operation.json');
  }

  private operationPath(operationId: string): string {
    if (!UUID_PATTERN.test(operationId)) throw new Error('Update operation ID is invalid.');
    return path.join(this.operationsDirectory, `${operationId}.json`);
  }

  private eventPath(operationId: string): string {
    if (!UUID_PATTERN.test(operationId)) throw new Error('Update operation ID is invalid.');
    return path.join(this.eventsDirectory, `${operationId}.ndjson`);
  }

  async initialize(): Promise<void> {
    const existing = await fs.lstat(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Update journal root is unsafe.');
    await fs.mkdir(this.operationsDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.eventsDirectory, { recursive: true, mode: 0o700 });
    for (const directory of [this.root, this.operationsDirectory, this.eventsDirectory]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe update journal directory: ${directory}`);
      await fs.chmod(directory, 0o700);
    }
  }

  private async writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    await assertRegularOrMissing(filePath);
    const temporary = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, filePath);
      await fs.chmod(filePath, 0o600);
      await syncDirectory(path.dirname(filePath));
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async writeOperation(operation: SystemUpdateOperation): Promise<SystemUpdateOperation> {
    const validated = parseOperation(operation);
    await this.writeJsonAtomically(this.operationPath(validated.operationId), validated);
    await this.writeJsonAtomically(this.currentPath, { operationId: validated.operationId });
    return validated;
  }

  async readOperation(operationId: string): Promise<SystemUpdateOperation | null> {
    const filePath = this.operationPath(operationId);
    await assertRegularOrMissing(filePath);
    const content = await fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (content === null) return null;
    if (Buffer.byteLength(content, 'utf8') > 64 * 1024) throw new Error('Stored update operation is too large.');
    try {
      return parseOperation(JSON.parse(content) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Stored update operation is not valid JSON.');
      throw error;
    }
  }

  async readCurrentOperation(): Promise<SystemUpdateOperation | null> {
    await assertRegularOrMissing(this.currentPath);
    const content = await fs.readFile(this.currentPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (content === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new Error('Current update operation pointer is invalid.');
    }
    if (!isRecord(parsed) || typeof parsed.operationId !== 'string' || !UUID_PATTERN.test(parsed.operationId)) {
      throw new Error('Current update operation pointer is invalid.');
    }
    return this.readOperation(parsed.operationId);
  }

  async appendEvent(event: SystemUpdateEvent): Promise<SystemUpdateEvent> {
    const validated = validateSystemUpdateEvent({ ...event, message: redactJournalMessage(event.message) });
    if (!validated.ok) throw new Error(validated.error);
    const filePath = this.eventPath(validated.value.operationId);
    await assertRegularOrMissing(filePath);
    const handle = await fs.open(filePath, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated.value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(filePath, 0o600);
    return validated.value;
  }

  async readEvents(operationId: string, afterSequence = 0): Promise<SystemUpdateEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Event sequence cursor is invalid.');
    const filePath = this.eventPath(operationId);
    await assertRegularOrMissing(filePath);
    const content = await fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (Buffer.byteLength(content, 'utf8') > STANDALONE_UPDATE_MAX_JOURNAL_BYTES) {
      throw new Error('Stored update events exceed the journal size limit.');
    }
    const events: SystemUpdateEvent[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let input: unknown;
      try {
        input = JSON.parse(line) as unknown;
      } catch {
        throw new Error('Stored update event is not valid JSON.');
      }
      const event = validateSystemUpdateEvent(input);
      if (!event.ok || event.value.operationId !== operationId) throw new Error('Stored update event is invalid.');
      if (event.value.sequence > afterSequence) events.push(event.value);
    }
    return events;
  }

  async recoverInterruptedOperation(now = new Date()): Promise<SystemUpdateOperation | null> {
    const current = await this.readCurrentOperation();
    if (!current || isTerminalSystemUpdateStatus(current.status)) return current;
    const recovered: SystemUpdateOperation = {
      ...current,
      status: 'indeterminate',
      updatedAt: now.toISOString(),
      completedAt: now.toISOString(),
      errorCode: 'operation_interrupted',
      error: 'The updater restarted before it could verify the final update state.',
    };
    await this.writeOperation(recovered);
    return recovered;
  }

  async rotate(): Promise<void> {
    const names = (await fs.readdir(this.operationsDirectory)).filter((name) => UUID_PATTERN.test(name.replace(/\.json$/u, '')) && name.endsWith('.json'));
    const entries = await Promise.all(names.map(async (name) => {
      const operationId = name.slice(0, -5);
      const operationPath = this.operationPath(operationId);
      const eventPath = this.eventPath(operationId);
      const [operationStat, eventStat] = await Promise.all([
        fs.stat(operationPath),
        fs.stat(eventPath).catch(() => null),
      ]);
      return { operationId, operationPath, eventPath, mtimeMs: operationStat.mtimeMs, bytes: operationStat.size + (eventStat?.size || 0) };
    }));
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let bytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const keep = index < STANDALONE_UPDATE_MAX_OPERATIONS && bytes + entry.bytes <= STANDALONE_UPDATE_MAX_JOURNAL_BYTES;
      if (keep) {
        bytes += entry.bytes;
        continue;
      }
      await Promise.all([
        fs.rm(entry.operationPath, { force: true }),
        fs.rm(entry.eventPath, { force: true }),
      ]);
    }
  }
}

export function createStandaloneUpdateOperation(input: {
  operationId: string;
  targetVersion: string;
  targetImageRef: string;
  currentVersion: string | null;
  now?: Date;
}): SystemUpdateOperation {
  const now = (input.now || new Date()).toISOString();
  return parseOperation({
    contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
    operationId: input.operationId,
    status: 'queued' satisfies SystemUpdateOperationStatus,
    stage: 'request_validation' satisfies SystemUpdateStage,
    targetVersion: input.targetVersion,
    targetImageRef: input.targetImageRef,
    currentVersion: input.currentVersion,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    rolledBack: false,
    errorCode: null,
    error: null,
    lastSequence: 0,
  });
}
