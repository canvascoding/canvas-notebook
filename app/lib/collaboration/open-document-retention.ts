/** Resource decisions for existing document lifetimes. This never opens a
 * document, authorizes a connection, or destroys local recovery data. */
export type OpenedDocumentRetentionTier = 'active' | 'live' | 'warm' | 'release';

export type OpenedDocumentRetentionCandidate = Readonly<{
  key: string;
  active: boolean;
  open: boolean;
  authCurrent: boolean;
  canKeepWarm: boolean;
  canKeepLive: boolean;
  encodedBytes: number;
  lastActivatedAt: number;
  backgroundSince: number;
}>;

export type OpenedDocumentRetentionLimits = Readonly<{
  liveDocuments: number;
  warmDocuments: number;
  backgroundDocumentBytes: number;
  backgroundTotalBytes: number;
  backgroundLiveMs: number;
  hiddenLiveMs: number;
}>;

const desktopLimits: OpenedDocumentRetentionLimits = Object.freeze({
  liveDocuments: 5, warmDocuments: 10, backgroundDocumentBytes: 1024 * 1024,
  backgroundTotalBytes: 8 * 1024 * 1024, backgroundLiveMs: 5 * 60_000, hiddenLiveMs: 2 * 60_000,
});
const constrainedLimits: OpenedDocumentRetentionLimits = Object.freeze({
  ...desktopLimits, liveDocuments: 2, warmDocuments: 5, backgroundTotalBytes: 4 * 1024 * 1024,
});

export function openedDocumentRetentionLimits(constrained: boolean): OpenedDocumentRetentionLimits {
  return constrained ? constrainedLimits : desktopLimits;
}

/** Times use the caller's monotonic clock. Keys span the whole app/auth scope,
 * including all workspaces. A release decision still requires the existing
 * confirmed-persistence/recovery fence before local state can be destroyed. */
export function planOpenedDocumentRetention(input: Readonly<{
  candidates: readonly OpenedDocumentRetentionCandidate[];
  constrained: boolean;
  now: number;
  hiddenSince?: number;
}>) {
  if (!Number.isFinite(input.now) || input.now < 0) throw new RangeError('A monotonic retention time is required.');
  const limits = openedDocumentRetentionLimits(input.constrained);
  const tiers = new Map<string, OpenedDocumentRetentionTier>();
  for (const candidate of input.candidates) {
    if (tiers.has(candidate.key)) throw new Error('Document retention keys must be unique.');
    tiers.set(candidate.key, candidate.active ? 'active' : 'release');
  }
  const activeDocuments = input.candidates.filter(candidate => candidate.active).length;
  // Reserve the visible slot even when its editor is an image, a scene, or has
  // not attached to this text-document registry yet.
  const availableLive = Math.max(0, limits.liveDocuments - Math.max(1, activeDocuments));
  const backgroundNetworkAllowed = input.hiddenSince === undefined
    || Number.isFinite(input.hiddenSince) && input.hiddenSince >= 0 && input.hiddenSince <= input.now
      && input.now - input.hiddenSince < limits.hiddenLiveMs;
  const background = input.candidates.filter(candidate => !candidate.active)
    .sort((left, right) => right.lastActivatedAt - left.lastActivatedAt || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  let backgroundLiveDocuments = 0, warmDocuments = 0, backgroundEncodedBytes = 0;
  for (const candidate of background) {
    if (!candidate.open || !candidate.authCurrent || !candidate.canKeepWarm
      || !Number.isSafeInteger(candidate.encodedBytes) || candidate.encodedBytes < 0
      || candidate.encodedBytes > limits.backgroundDocumentBytes
      || !Number.isFinite(candidate.lastActivatedAt) || candidate.lastActivatedAt < 0 || candidate.lastActivatedAt > input.now
      || !Number.isFinite(candidate.backgroundSince) || candidate.backgroundSince < 0 || candidate.backgroundSince > input.now
      || backgroundEncodedBytes + candidate.encodedBytes > limits.backgroundTotalBytes) continue;
    if (candidate.canKeepLive && backgroundNetworkAllowed && backgroundLiveDocuments < availableLive
      && input.now - candidate.backgroundSince < limits.backgroundLiveMs) {
      tiers.set(candidate.key, 'live'); backgroundLiveDocuments++;
    } else if (warmDocuments < limits.warmDocuments) {
      tiers.set(candidate.key, 'warm'); warmDocuments++;
    } else continue;
    backgroundEncodedBytes += candidate.encodedBytes;
  }
  return {
    decisions: input.candidates.map(candidate => ({ key: candidate.key, tier: tiers.get(candidate.key)! })),
    activeDocuments, backgroundLiveDocuments, warmDocuments, backgroundEncodedBytes,
  };
}
