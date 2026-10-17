import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import type { Doc } from 'yjs';
import type { CollaborationRoomOwnerFence, CollaborationRoomOwnerScope } from './room-owner';
import type { CollaborationTicketClaims } from './types';

type RoomIdentity = Pick<CollaborationTicketClaims, 'documentId' | 'workspaceId' | 'organizationId'
  | 'path' | 'lifecycleGeneration' | 'representation' | 'schemaVersion'>;
type Room = Doc & { isLoading?: boolean };
export type SearchRoomVisibility = 'all' | 'exclude_dot_segments';
export type SearchRoomCensusIssue = 'loading' | 'unloading' | 'draining' | 'owner_lost'
  | 'owner_unfenced' | 'identity_missing' | 'identity_invalid' | 'destroyed' | 'limit'
  | 'runtime_unavailable' | 'not_installed' | 'transaction_active';
export type SearchRoomCensus = Readonly<{
  workspaceId: string;
  visibility: SearchRoomVisibility;
  serverEpoch: string | null;
  revision: string;
  /** This is deliberately not a claim about other processes or the SQL corpus. */
  completeFor: 'same_process_loaded_text_rooms';
  complete: boolean;
  remoteCoverage: 'unknown';
  uncertainty: readonly SearchRoomCensusIssue[];
  rooms: readonly Readonly<CollaborationRoomOwnerScope & { issues: readonly SearchRoomCensusIssue[] }>[];
  /** Call after native reads AND the independent final SQL census, before publication. */
  assertCurrent(): void;
  /** Comparison evidence only. Callers supply the actual SQL owner observation;
   * this neither authorizes a read nor proves that the SQL observation is current. */
  coversOwner(owner: CollaborationRoomOwnerFence): boolean;
}>;

type Source = Readonly<{
  maps(): Readonly<{
    documents: ReadonlyMap<string, Room>;
    loadingDocuments: ReadonlyMap<string, Promise<unknown>>;
    unloadingDocuments: ReadonlyMap<string, Promise<unknown>>;
  }>;
  identity(document: Doc): RoomIdentity | undefined;
  owner(document: Doc): CollaborationRoomOwnerFence | undefined;
  isDraining(documentId: string): boolean;
  assertAvailable(): void;
}>;
type Provider = { epoch: string; capture(workspaceId: string, limit: number, visibility: SearchRoomVisibility): SearchRoomCensus; dispose(): void };
type Registry = { version: 1; generation: bigint; current?: Provider };
const key = Symbol.for('canvas.collaboration.search-room-census.v1');
const globals = globalThis as typeof globalThis & { [key]?: Registry };
const registry = globals[key] ??= { version: 1, generation: BigInt(0) };
const MAX_ROOMS = 4096, DEFAULT_ROOMS = 1024;

export class SearchRoomCensusChangedError extends Error {
  readonly code = 'SEARCH_ROOM_CENSUS_CHANGED';
  constructor() { super('The local collaboration rooms changed during the search.'); this.name = 'SearchRoomCensusChangedError'; }
}
const changed = (): never => { throw new SearchRoomCensusChangedError(); };
const scopeValues = (s: RoomIdentity) => [s.documentId, s.workspaceId, s.organizationId, s.path,
  s.lifecycleGeneration, s.representation, s.schemaVersion];
const ownerValues = (f: CollaborationRoomOwnerFence) => [...scopeValues(f.scope), f.epoch, f.token, f.backendPid, f.backendStart];
const sameScope = (a: RoomIdentity, b: RoomIdentity) => scopeValues(a).every((v, i) => Object.is(v, scopeValues(b)[i]));
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0
  && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function validIdentity(identity: RoomIdentity): boolean {
  return text(identity.documentId, 1024) && text(identity.workspaceId, 1024)
    && (identity.organizationId === null || text(identity.organizationId, 1024)) && text(identity.path, 16384)
    && positive(identity.lifecycleGeneration) && positive(identity.schemaVersion)
    && ['plain_text', 'tiptap_xml', 'tiptap_blocks', 'excalidraw_scene'].includes(identity.representation);
}
function validOwner(owner: CollaborationRoomOwnerFence, identity: RoomIdentity): boolean {
  return owner && sameScope(owner.scope, identity) && positive(owner.epoch) && text(owner.token, 1024)
    && positive(owner.backendPid) && text(owner.backendStart, 1024);
}

/** Installed only by the actual collaboration server. This observer never loads,
 * stores, serializes, admits or authorizes documents. All observations are sync. */
export function installCollaborationSearchRoomCensus(source: Source): () => void {
  const epoch = randomUUID();
  let closed = false;
  type Tracked = { token: string; updates: bigint; destroyed: boolean; attached: boolean;
    beforeTransaction(): void; update(): void; destroy(): void; reference: WeakRef<Room>; key: string };
  const tracked = new WeakMap<Room, Tracked>();
  const listeners = new Set<Tracked>();
  const tokens = new WeakMap<object, string>();
  const token = (object: object) => {
    let value = tokens.get(object);
    if (!value) { value = randomUUID(); tokens.set(object, value); }
    return value;
  };
  const detach = (state: Tracked) => {
    const document = state.reference.deref();
    document?.off('beforeTransaction', state.beforeTransaction);
    document?.off('update', state.update); document?.off('destroy', state.destroy);
    state.attached = false; listeners.delete(state);
  };
  const observe = (document: Room, documentId: string) => {
    let state = tracked.get(document);
    if (state?.attached) return state;
    state = { token: randomUUID(), updates: BigInt(0), destroyed: document.isDestroyed, attached: true,
      reference: new WeakRef(document), key: documentId,
      beforeTransaction() { this.updates++; }, update() { this.updates++; }, destroy() { this.destroyed = true; } };
    // Yjs invokes listeners without their receiver. Bind to the private tracker,
    // and attach BEFORE any state/identity/fence is captured, including deletes.
    state.beforeTransaction = state.beforeTransaction.bind(state);
    state.update = state.update.bind(state); state.destroy = state.destroy.bind(state);
    // Also invalidate before mutations: an earlier update observer may throw,
    // and a dependency-missing update may change pending state without emitting
    // update. An unfinished transaction is reported separately below.
    document.on('beforeTransaction', state.beforeTransaction);
    document.on('update', state.update); document.on('destroy', state.destroy);
    tracked.set(document, state); listeners.add(state);
    return state;
  };
  const capture = (workspaceId: string, limit: number, visibility: SearchRoomVisibility): SearchRoomCensus => {
    if (closed) changed();
    const maps = source.maps();
    const issues = new Set<SearchRoomCensusIssue>();
    const witnesses: string[] = [];
    const rooms: Array<CollaborationRoomOwnerScope & { issues: readonly SearchRoomCensusIssue[] }> = [];
    const owners = new Map<string, string>();
    const excluded = (identity: RoomIdentity) => identity.workspaceId !== workspaceId
      || identity.representation === 'excalidraw_scene'
      || visibility === 'exclude_dot_segments' && identity.path.split('/').some(segment => segment.startsWith('.'));
    for (const state of listeners) {
      const document = state.reference.deref();
      if (!document || document.isDestroyed || maps.documents.get(state.key) !== document) detach(state);
    }
    try { source.assertAvailable(); } catch { issues.add('runtime_unavailable'); }
    let inspected = 0;
    for (const [documentId, document] of maps.documents) {
      if (inspected++ >= limit) { issues.add('limit'); break; }
      const state = observe(document, documentId);
      const identity = source.identity(document);
      if (!identity || !validIdentity(identity) || identity.documentId !== documentId) {
        issues.add(identity ? 'identity_invalid' : 'identity_missing');
        witnesses.push(JSON.stringify(['unknown', state.token, state.updates.toString(), state.destroyed]));
        continue;
      }
      if (excluded(identity)) continue;
      const roomIssues: SearchRoomCensusIssue[] = [];
      if (document.isDestroyed || state.destroyed) roomIssues.push('destroyed');
      if (document._transaction !== null || document._transactionCleanups.length !== 0) roomIssues.push('transaction_active');
      if (document.isLoading || maps.loadingDocuments.has(documentId)) roomIssues.push('loading');
      if (maps.unloadingDocuments.has(documentId)) roomIssues.push('unloading');
      if (source.isDraining(documentId)) roomIssues.push('draining');
      let fence: CollaborationRoomOwnerFence | undefined;
      try {
        fence = source.owner(document);
        if (!fence) roomIssues.push('owner_unfenced');
        else if (!validOwner(fence, identity)) { roomIssues.push('owner_lost'); fence = undefined; }
      } catch { roomIssues.push('owner_lost'); }
      roomIssues.forEach(issue => issues.add(issue));
      const scope: CollaborationRoomOwnerScope = Object.freeze({ documentId: identity.documentId,
        workspaceId: identity.workspaceId, organizationId: identity.organizationId, path: identity.path,
        lifecycleGeneration: identity.lifecycleGeneration,
        representation: identity.representation as CollaborationRoomOwnerScope['representation'], schemaVersion: identity.schemaVersion });
      rooms.push(Object.freeze({ ...scope, issues: Object.freeze(roomIssues) }));
      const ownerWitness = fence ? JSON.stringify(ownerValues(fence)) : null;
      if (ownerWitness && roomIssues.length === 0) owners.set(documentId, ownerWitness);
      witnesses.push(JSON.stringify([state.token, state.updates.toString(), state.destroyed,
        token(identity), scopeValues(scope), ownerWitness, roomIssues]));
    }
    // Loading entries are not yet in `documents`. Their workspace is unknown
    // until the genuine loaded identity exists; never infer it from client claims.
    for (const [kind, pending] of [['loading', maps.loadingDocuments], ['unloading', maps.unloadingDocuments]] as const) {
      let count = 0;
      for (const [id, promise] of pending) {
        if (count++ >= limit) { issues.add('limit'); break; }
        const room = maps.documents.get(id), identity = room && source.identity(room);
        if (identity && validIdentity(identity) && excluded(identity)) continue;
        issues.add(kind); witnesses.push(JSON.stringify([kind, id, token(promise)]));
      }
    }
    const uncertainty = Object.freeze([...issues].sort());
    const hash = createHash('sha256').update(JSON.stringify(['canvas-search-room-census', 1, epoch, workspaceId, limit, visibility,
      token(maps.documents), token(maps.loadingDocuments), token(maps.unloadingDocuments), uncertainty]));
    for (const witness of witnesses.sort()) hash.update('\0').update(witness);
    const revision = `src1:${hash.digest('hex')}`;
    rooms.sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0);
    return Object.freeze({ workspaceId, visibility, serverEpoch: epoch, revision, completeFor: 'same_process_loaded_text_rooms',
      complete: issues.size === 0, remoteCoverage: 'unknown', uncertainty, rooms: Object.freeze(rooms),
      assertCurrent() { if (closed || capture(workspaceId, limit, visibility).revision !== revision) changed(); },
      coversOwner(owner: CollaborationRoomOwnerFence) {
        return owner?.scope?.workspaceId === workspaceId && owners.get(owner.scope.documentId) === JSON.stringify(ownerValues(owner));
      } });
  };
  const provider: Provider = { epoch, capture, dispose() {
    if (closed) return;
    closed = true;
    for (const state of listeners) detach(state);
  } };
  registry.current?.dispose();
  registry.current = provider; registry.generation++;
  return () => {
    provider.dispose();
    if (registry.current === provider) { delete registry.current; registry.generation++; }
  };
}

/** Internal comparison evidence, never a grant. Missing runtime means unknown,
 * not zero live rooms. Public search DTOs must not serialize these handles. */
export function captureLocalCollaborationSearchRooms(workspaceId: string, maxRooms = DEFAULT_ROOMS,
  visibility: SearchRoomVisibility = 'all'): SearchRoomCensus {
  if (!text(workspaceId, 1024) || !Number.isSafeInteger(maxRooms) || maxRooms < 1 || maxRooms > MAX_ROOMS
    || visibility !== 'all' && visibility !== 'exclude_dot_segments') {
    throw new TypeError('Invalid collaboration search census selection.');
  }
  const provider = registry.current, generation = registry.generation;
  const assertRegistration = () => { if (registry.current !== provider || registry.generation !== generation) changed(); };
  if (!provider) return Object.freeze({ workspaceId, visibility, serverEpoch: null, revision: `src1:absent:${generation}`,
    completeFor: 'same_process_loaded_text_rooms', complete: false, remoteCoverage: 'unknown',
    uncertainty: Object.freeze(['not_installed'] as const), rooms: Object.freeze([]),
    assertCurrent: assertRegistration, coversOwner: () => false });
  const observed = provider.capture(workspaceId, maxRooms, visibility);
  assertRegistration();
  return Object.freeze({ ...observed, assertCurrent() {
    assertRegistration();
    // The server and a compiled consumer can carry distinct module/error
    // constructors. Revalidation failures always use this caller's class.
    try { observed.assertCurrent(); } catch { changed(); }
    assertRegistration();
  } });
}
