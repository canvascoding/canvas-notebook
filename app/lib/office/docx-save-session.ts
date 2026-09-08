import { DocxClientError, type DocxBaseline, type DocxIdentity, type DocxLease, type DocxSaveClient } from './docx-client';
import { docxRecoveryKey, type DocxRecoveryRecord, type DocxRecoveryStore } from './docx-recovery';

export interface DocxSaveState {
  dirty: boolean;
  pending: boolean;
  saving: boolean;
  readOnly: boolean;
  leaseExpiresAt: number | null;
  error: Error | null;
  recoveryError: Error | null;
  generation: number;
  savedGeneration: number;
}

interface DocxSaveOptions<T> {
  identity: DocxIdentity;
  baseline: DocxBaseline;
  originalBytes: Uint8Array;
  initialDocument: T;
  serialize(snapshot: T): Promise<Uint8Array | ArrayBuffer | Blob>;
  client: DocxSaveClient;
  recovery: DocxRecoveryStore<T>;
  onState?(state: DocxSaveState): void;
  debounceMs?: number;
  maxWaitMs?: number;
  /** Shorter intervals are useful in tests; production defaults are 120s / 30s. */
  leaseTtlMs?: number;
  renewMs?: number;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function copyBytes(value: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(await value.arrayBuffer());
}

/** One immutable document identity, one export/upload flight and one bounded recovery queue. */
export class DocxSaveSession<T> {
  readonly identity: Readonly<DocxIdentity>;
  private baseline: DocxBaseline;
  private originalBytes: Uint8Array;
  private document: T;
  private generation = 0;
  private savedGeneration = 0;
  private error: Error | null = null;
  private recoveryError: Error | null = null;
  private readOnly = true;
  private disposed = false;
  private lease: DocxLease | null = null;
  private leaseEpoch = 0;
  private leaseInvalid = true;
  private startFlight: Promise<void> | null = null;
  private saveFlight: Promise<void> | null = null;
  private recoveryFlight: Promise<void> | null = null;
  private queuedRecovery: DocxRecoveryRecord<T> | null = null;
  private request: DocxRecoveryRecord<T>['pendingRequest'] = null;
  private firstDirtyAt: number | null = null;
  private nextDirtyAt: number | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private abort = new AbortController();

  constructor(private readonly options: DocxSaveOptions<T>) {
    this.identity = Object.freeze({ ...options.identity });
    this.baseline = { ...options.baseline };
    this.originalBytes = options.originalBytes.slice();
    this.document = structuredClone(options.initialDocument);
  }

  getState(): DocxSaveState {
    const dirty = this.generation > this.savedGeneration || this.request !== null || this.recoveryError !== null;
    return {
      dirty, pending: dirty || this.saveFlight !== null || this.recoveryFlight !== null || this.recoveryError !== null,
      saving: this.saveFlight !== null, readOnly: this.readOnly,
      leaseExpiresAt: this.lease?.expiresAt ?? null, error: this.error, recoveryError: this.recoveryError,
      generation: this.generation, savedGeneration: this.savedGeneration,
    };
  }

  getDocument(): T { return structuredClone(this.document); }
  getBaseline(): DocxBaseline { return { ...this.baseline }; }

  private emit(): void {
    if (!this.disposed) this.options.onState?.(this.getState());
  }

  private assertActive(): void {
    if (this.disposed) throw new DocxClientError('This document editor is closed.', 'EDITOR_DISPOSED');
  }

  private invalidateLease(error: unknown): void {
    this.leaseEpoch++;
    this.leaseInvalid = true;
    this.readOnly = true;
    this.error = asError(error);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.emit();
  }

  private leaseIsLive(): boolean {
    return this.lease !== null && this.lease.expiresAt > Date.now();
  }

  start(): Promise<void> {
    this.assertActive();
    if (this.startFlight) return this.startFlight;
    const epoch = this.leaseEpoch;
    const { path, sessionId } = this.identity;
    this.startFlight = this.options.client.acquire(path, sessionId, this.baseline.revisionId, this.options.leaseTtlMs ?? 120_000, this.abort.signal)
      .then(async (lease) => {
        if (this.disposed || epoch !== this.leaseEpoch) {
          await this.options.client.release(path, sessionId, lease.id).catch(() => undefined);
          return;
        }
        if (!lease.id || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) throw new DocxClientError('The document lease has expired.', 'LEASE_EXPIRED');
        this.lease = lease;
        this.leaseInvalid = false;
        this.readOnly = false;
        this.error = null;
        this.armLeaseTimers(epoch);
        this.emit();
      }).catch((error) => {
        if (!this.disposed) this.invalidateLease(error);
        throw error;
      });
    return this.startFlight;
  }

  private armLeaseTimers(epoch: number): void {
    if (!this.lease || this.disposed) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.expiryTimer = setTimeout(() => {
      if (!this.disposed && epoch === this.leaseEpoch) this.invalidateLease(new DocxClientError('The document lease expired. Reopen the document to edit again.', 'LEASE_EXPIRED'));
    }, Math.max(0, this.lease.expiresAt - Date.now()));
    this.renewTimer = setTimeout(() => { void this.renewLease(epoch); }, this.options.renewMs ?? 30_000);
  }

  private async renewLease(epoch: number): Promise<void> {
    const previous = this.lease;
    if (this.disposed || epoch !== this.leaseEpoch || !previous) return;
    if (!this.leaseIsLive()) { this.invalidateLease(new DocxClientError('The document lease expired.', 'LEASE_EXPIRED')); return; }
    try {
      const next = await this.options.client.renew(this.identity.path, this.identity.sessionId, previous.id, this.options.leaseTtlMs ?? 120_000, this.abort.signal);
      if (this.disposed || epoch !== this.leaseEpoch) return;
      // A delayed answer cannot resurrect a lease whose locally known deadline passed.
      if (Date.now() >= previous.expiresAt || next.id !== previous.id || !Number.isFinite(next.expiresAt) || next.expiresAt <= Date.now()) {
        this.invalidateLease(new DocxClientError('The document lease expired or changed.', 'LEASE_EXPIRED'));
        return;
      }
      this.lease = next;
      this.armLeaseTimers(epoch);
      this.emit();
    } catch (error) {
      if (!this.disposed && epoch === this.leaseEpoch) this.invalidateLease(error);
    }
  }

  change(document: T): void {
    this.assertActive();
    if (this.readOnly || !this.leaseIsLive()) {
      if (!this.readOnly) this.invalidateLease(new DocxClientError('The document lease expired.', 'LEASE_EXPIRED'));
      throw this.error ?? new DocxClientError('This document is read-only.', 'DOCUMENT_READ_ONLY');
    }
    // Clone before returning to the editor: further mutations cannot alter this generation.
    this.document = structuredClone(document);
    this.generation++;
    this.firstDirtyAt ??= Date.now();
    if (this.saveFlight) this.nextDirtyAt ??= Date.now();
    this.emit();
    this.queueRecovery();
    this.scheduleSave();
  }

  private record(): DocxRecoveryRecord<T> {
    return {
      version: 1, identity: { ...this.identity }, baseline: { ...this.baseline },
      originalBytes: this.originalBytes, document: this.document, generation: this.generation,
      savedGeneration: this.savedGeneration, pendingRequest: this.request, updatedAt: Date.now(),
    };
  }

  private queueRecovery(): void {
    // At most the active IndexedDB transaction and the latest model await persistence.
    this.queuedRecovery = this.record();
    if (this.recoveryFlight) return;
    this.recoveryFlight = Promise.resolve().then(async () => {
      while (this.queuedRecovery) {
        const record = this.queuedRecovery;
        this.queuedRecovery = null;
        try {
          await this.options.recovery.save(record);
          this.recoveryError = null;
        } catch (error) {
          this.recoveryError = asError(error);
          // Keep the latest in memory for an explicit retry; avoid a busy retry loop.
          this.queuedRecovery ??= this.record();
          break;
        }
      }
    }).finally(() => {
      this.recoveryFlight = null;
      // A change can arrive between the last await and this completion microtask.
      if (this.queuedRecovery && !this.recoveryError) this.queueRecovery();
      this.emit();
    });
    this.emit();
  }

  private async persist(): Promise<void> {
    this.queueRecovery();
    while (this.recoveryFlight) {
      await this.recoveryFlight;
      if (this.recoveryError) throw this.recoveryError;
    }
  }

  /** Preserve the draft before explicitly reopening the saved file; does not publish or mark clean. */
  async preserveDraft(): Promise<void> {
    this.assertActive();
    // Persistence already in progress survives disposal; only UI/network callbacks are stopped.
    await this.persist();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.disposed || this.readOnly || this.error || this.saveFlight) return;
    const maximum = (this.options.maxWaitMs ?? 10_000) - (Date.now() - (this.firstDirtyAt ?? Date.now()));
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.save(false).catch(() => undefined); }, Math.max(0, Math.min(this.options.debounceMs ?? 2_000, maximum)));
  }

  flush(): Promise<void> {
    this.assertActive();
    if (this.saveFlight) return this.saveFlight.then(() => this.flush());
    return this.save(true);
  }

  private save(drain: boolean): Promise<void> {
    this.assertActive();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.saveFlight) return this.saveFlight;
    this.saveFlight = Promise.resolve().then(async () => {
      while (this.generation > this.savedGeneration || this.request) {
        this.assertActive();
        if (!this.request) {
          if (this.readOnly || !this.leaseIsLive()) throw this.error ?? new DocxClientError('A valid document lease is required.', 'DOCUMENT_READ_ONLY');
          const generation = this.generation;
          this.nextDirtyAt = null;
          const snapshot = structuredClone(this.document);
          const bytes = await copyBytes(await this.options.serialize(snapshot));
          this.assertActive();
          if (this.readOnly || !this.leaseIsLive()) throw this.error ?? new DocxClientError('The document lease expired during export.', 'LEASE_EXPIRED');
          this.request = {
            path: this.identity.path, sessionId: this.identity.sessionId, lockId: this.lease!.id,
            expectedSha256: this.baseline.sha256, baseRevisionId: this.baseline.revisionId,
            idempotencyKey: crypto.randomUUID(), bytes, generation,
          };
        }
        // The exact request is durable before the server can possibly acknowledge it.
        await this.persist();
        this.assertActive();
        const request = this.request!;
        const result = await this.options.client.write(request, this.abort.signal);
        this.assertActive();
        if (!result.sha256 || !result.revisionId) throw new DocxClientError('Missing saved document revision.', 'INVALID_RESPONSE');
        this.baseline = { ...result };
        this.originalBytes = request.bytes.slice();
        this.savedGeneration = request.generation;
        this.request = null;
        this.error = null;
        this.firstDirtyAt = this.generation === this.savedGeneration ? null : (this.nextDirtyAt ?? Date.now());
        // Persist acknowledgment before reporting clean, including any newer editor model.
        await this.persist();
        this.assertActive();
        this.emit();
        if (!drain) break;
      }
      if (this.recoveryError) await this.persist();
    }).catch((error) => {
      if (!this.disposed) {
        if (error instanceof DocxClientError && [401, 403, 404, 409, 412].includes(error.status)) this.invalidateLease(error);
        else { this.error = asError(error); this.readOnly = true; this.emit(); }
      }
      throw error;
    }).finally(() => {
      this.saveFlight = null;
      this.emit();
      if (this.generation > this.savedGeneration && !this.error) this.scheduleSave();
    });
    this.emit();
    return this.saveFlight;
  }

  async retry(): Promise<void> {
    this.assertActive();
    this.error = null;
    if (!this.leaseInvalid && this.leaseIsLive()) this.readOnly = false;
    await this.flush();
  }

  async exportCopy(): Promise<Uint8Array> {
    this.assertActive();
    const bytes = await copyBytes(await this.options.serialize(structuredClone(this.document)));
    this.assertActive();
    return bytes;
  }

  async getRecovery(): Promise<DocxRecoveryRecord<T> | null> {
    this.assertActive();
    try {
      const record = await this.options.recovery.load({ ...this.identity });
      this.assertActive();
      if (!record || record.version !== 1 || docxRecoveryKey(record.identity) !== docxRecoveryKey(this.identity)) return null;
      return record.generation > record.savedGeneration || record.pendingRequest ? structuredClone(record) : null;
    } catch (error) {
      if (!this.disposed) { this.recoveryError = asError(error); this.emit(); }
      throw error;
    }
  }

  async restoreRecovery(record: DocxRecoveryRecord<T>): Promise<T> {
    this.assertActive();
    if (this.saveFlight || this.generation !== 0) throw new DocxClientError('Restore recovery before editing or saving.', 'RECOVERY_ALREADY_EDITING');
    if (record.version !== 1 || docxRecoveryKey(record.identity) !== docxRecoveryKey(this.identity)) {
      throw new DocxClientError('This recovery belongs to another document or account.', 'RECOVERY_IDENTITY_MISMATCH');
    }
    if (!record.baseline?.sha256 || !record.baseline.revisionId || !Number.isSafeInteger(record.generation) || !Number.isSafeInteger(record.savedGeneration) || record.savedGeneration < 0 || record.generation < record.savedGeneration || !(record.originalBytes instanceof Uint8Array)
      || (record.pendingRequest && (record.pendingRequest.path !== this.identity.path || record.pendingRequest.expectedSha256 !== record.baseline.sha256 || record.pendingRequest.baseRevisionId !== record.baseline.revisionId || !(record.pendingRequest.bytes instanceof Uint8Array) || record.pendingRequest.generation > record.generation || record.pendingRequest.generation <= record.savedGeneration))) {
      throw new DocxClientError('The local document recovery is incomplete or inconsistent.', 'INVALID_RECOVERY');
    }
    const restored = structuredClone(record);
    // Never replace these original preconditions with the latest file read by the UI.
    this.baseline = restored.baseline;
    this.originalBytes = restored.originalBytes;
    this.document = restored.document;
    this.generation = restored.generation;
    this.savedGeneration = restored.savedGeneration;
    this.request = restored.pendingRequest;
    this.firstDirtyAt = Date.now();
    this.emit();
    await this.persist();
    this.assertActive();
    return this.getDocument();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.leaseEpoch++;
    this.abort.abort();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.lease) void this.options.client.release(this.identity.path, this.identity.sessionId, this.lease.id).catch(() => undefined);
  }
}
