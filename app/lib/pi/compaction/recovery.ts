/**
 * Portions adapted from NousResearch/hermes-agent at
 * f293e7206b4ddd66042329442c6afebc19a8808d.
 * Copyright (c) 2025 Nous Research, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { isPiActionableUserMessage } from './selection';
import { isPiLowSignalToolResult } from './pruning';

export const PI_COMPACTION_ANCHOR_HEADING = '## Anchor Index (mechanically extracted, exact)';
export const PI_COMPACTION_USER_MESSAGES_HEADING = '## User Messages (verbatim, newest first)';
export const PI_COMPACTION_DIGESTS_HEADING = '## Detailed Session Log (chunked digests, oldest first)';
export const PI_COMPACTION_RECOVERY_HEADING = '## Context Recovery';

const ANCHOR_BUDGET_CHARACTERS = 7_000;
const USER_MESSAGES_BUDGET_CHARACTERS = 24_000;
const USER_MESSAGE_MAX_CHARACTERS = 4_000;
const DIGEST_CHUNK_CHARACTERS = 72_000;
const DIGEST_MAX_CHUNKS = 28;
const SUMMARY_INPUT_MAX_CHARACTERS = 160_000;

type AnchorPattern = Readonly<{
  label: string;
  pattern: RegExp;
  cap: number;
}>;

const ANCHOR_PATTERNS: readonly AnchorPattern[] = Object.freeze([
  { label: 'PRs/issues', pattern: /#\d{1,7}\b/gu, cap: 120 },
  { label: 'commits', pattern: /\b[0-9a-f]{9,40}\b/gu, cap: 40 },
  { label: 'branches', pattern: /\b(?:fix|feat|docs|refactor|chore|salvage|codex)\/[A-Za-z0-9._/-]{3,80}/gu, cap: 40 },
  { label: 'files', pattern: /\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|mjs|cjs|rs|md|yaml|yml|json|toml|sh|sql)\b/gu, cap: 100 },
  { label: 'errors', pattern: /\b(?:[A-Z][a-zA-Z]*Error|Exception|ENOSPC|EACCES|SIGKILL|SQLITE_BUSY|Traceback)\b[^\n]{0,120}/gu, cap: 50 },
  { label: 'handles', pattern: /@[A-Za-z0-9-]{3,30}\b/gu, cap: 40 },
  { label: 'urls', pattern: /https?:\/\/[^\s)"'<>]{8,160}/gu, cap: 40 },
  { label: 'versions', pattern: /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/gu, cap: 40 },
  { label: 'uuids', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, cap: 80 },
  { label: 'workspace IDs', pattern: /\bworkspace(?:Id|_id)?\s*[:=]\s*[A-Za-z0-9._:-]{3,128}/giu, cap: 80 },
  { label: 'todo IDs', pattern: /\btodo(?:Id|_id)?\s*[:=]\s*[A-Za-z0-9._:-]{3,128}/giu, cap: 80 },
  { label: 'automation IDs', pattern: /\bautomation(?:Id|_id)?\s*[:=]\s*[A-Za-z0-9._:-]{3,128}/giu, cap: 80 },
  { label: 'session IDs', pattern: /\bsession(?:Id|_id)?\s*[:=]\s*[A-Za-z0-9._:-]{3,128}/giu, cap: 80 },
]);

const ANCHOR_NOISE = new Set(['@canvas']);
const SENSITIVE_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|authorization|cookie)\b(\s*[:=]\s*)(["']?)([^\s,;"']{4,})(\3)/giu;
const SENSITIVE_JSON_ASSIGNMENT = /(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|authorization|cookie)["']\s*:\s*)(["'])([^"']{4,})(\2)/giu;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const COMMON_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu;
const URL_PATTERN = /https?:\/\/[^\s<>{}\[\]()"']+/gu;
const SENSITIVE_QUERY_KEY = /(?:token|key|code|secret|signature|sig|auth|password|passwd|credential|session)/iu;

export type PiCompactionAnchorIndex = Readonly<{
  categories: Readonly<Record<string, readonly string[]>>;
  text: string;
}>;

export type PiCompactionDigestChunk = Readonly<{
  ordinal: number;
  total: number;
  startCharacter: number;
  endCharacter: number;
  digest: string;
  content: string;
}>;

export type PiCompactionRecoveryArtifacts = Readonly<{
  redactedTranscript: string;
  anchorIndex: PiCompactionAnchorIndex;
  verbatimUserSection: string;
  digestChunks: readonly PiCompactionDigestChunk[];
  recoveryFooter: string;
}>;

function messageContentText(message: AgentMessage): string {
  if (!('content' in message)) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const record = part as unknown as Record<string, unknown>;
    if (record.type === 'toolCall') {
      const name = typeof record.name === 'string' ? record.name : 'unknown';
      let serializedArguments = '';
      try {
        serializedArguments = JSON.stringify(record.arguments ?? {});
      } catch {
        serializedArguments = String(record.arguments ?? '');
      }
      return [`[toolCall ${name}] ${serializedArguments}`];
    }
    const text = typeof record.text === 'string'
      ? record.text
      : typeof record.content === 'string'
        ? record.content
        : '';
    return text ? [text] : [];
  }).join('\n');
}

function redactUrlCredentials(candidate: string): string {
  const trailing = candidate.match(/[.,;:!?]+$/u)?.[0] ?? '';
  const raw = trailing ? candidate.slice(0, -trailing.length) : candidate;
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = 'redacted';
      url.password = 'redacted';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    if (url.hash) url.hash = '#[REDACTED]';
    return `${url.toString()}${trailing}`;
  } catch {
    return candidate;
  }
}

/** Strict persistence-boundary redaction, including URL userinfo and OAuth query values. */
export function redactPiCompactionText(
  value: string,
  knownSecrets: readonly string[] = [],
): string {
  let redacted = value;
  for (const secret of knownSecrets) {
    if (secret.length >= 4) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  redacted = redacted
    .replace(PRIVATE_KEY, '[REDACTED_PRIVATE_KEY]')
    .replace(BEARER_TOKEN, '$1[REDACTED]')
    .replace(COMMON_TOKEN, '[REDACTED]')
    .replace(SENSITIVE_JSON_ASSIGNMENT, '$1$2[REDACTED]$4')
    .replace(SENSITIVE_ASSIGNMENT, '$1$2$3[REDACTED]$5')
    .replace(URL_PATTERN, redactUrlCredentials);
  return redacted;
}

function redactedMessageText(message: AgentMessage, knownSecrets: readonly string[]): string {
  return redactPiCompactionText(messageContentText(message), knownSecrets);
}

function isSyntheticUserText(value: string): boolean {
  const text = value.trimStart();
  return !text || [
    '[System:',
    '[CONTEXT',
    '[PRIOR CONTEXT',
    '[IMPORTANT: Background',
    '[Your active task list',
    '[Planning state preserved',
    '[ASYNC DELEGATION',
    '[OUT-OF-BAND',
    'Cronjob Response:',
    'Internal session summary from earlier turns.',
    '<internal_session_summary>',
  ].some((prefix) => text.startsWith(prefix));
}

export function buildPiCompactionAnchorIndex(
  messages: readonly AgentMessage[],
  knownSecrets: readonly string[] = [],
): PiCompactionAnchorIndex {
  const text = messages.map((message) => redactedMessageText(message, knownSecrets)).filter(Boolean).join('\n');
  const categories: Record<string, readonly string[]> = {};
  const lines: string[] = [];
  let used = 0;
  for (const { label, pattern, cap } of ANCHOR_PATTERNS) {
    const counts = new Map<string, number>();
    const lastSeen = new Map<string, number>();
    let matchIndex = 0;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const anchor = match[0].trim().replace(/[.,;:]+$/u, '');
      if (!anchor || ANCHOR_NOISE.has(anchor.toLowerCase()) || anchor.includes('[REDACTED]')) continue;
      counts.set(anchor, (counts.get(anchor) ?? 0) + 1);
      lastSeen.set(anchor, matchIndex);
      matchIndex += 1;
    }
    const ranked = [...counts.keys()]
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)
        || (lastSeen.get(b) ?? 0) - (lastSeen.get(a) ?? 0))
      .slice(0, cap);
    if (ranked.length === 0) continue;
    const line = `${label}: ${ranked.map((anchor) => (
      (counts.get(anchor) ?? 0) > 1 ? `${anchor}(x${counts.get(anchor)})` : anchor
    )).join(', ')}`;
    if (used + line.length > ANCHOR_BUDGET_CHARACTERS) break;
    categories[label] = Object.freeze(ranked);
    lines.push(line);
    used += line.length;
  }
  const rendered = lines.length === 0
    ? ''
    : `\n\n${PI_COMPACTION_ANCHOR_HEADING}\n${lines.join('\n')}\n`
      + '(Exact identifiers from the compacted region. Use them verbatim and as session_search query anchors.)';
  return Object.freeze({ categories: Object.freeze(categories), text: rendered });
}

export function buildPiCompactionVerbatimUserSection(
  messages: readonly AgentMessage[],
  knownSecrets: readonly string[] = [],
): string {
  const collected: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isPiActionableUserMessage(message)) continue;
    let text = redactedMessageText(message, knownSecrets).trim();
    if (isSyntheticUserText(text)) continue;
    if (text.length > USER_MESSAGE_MAX_CHARACTERS) {
      text = `${text.slice(0, USER_MESSAGE_MAX_CHARACTERS).trimEnd()} …[truncated]`;
    }
    const remaining = USER_MESSAGES_BUDGET_CHARACTERS - used;
    if (remaining <= 0) break;
    if (text.length > remaining) text = `${text.slice(0, remaining).trimEnd()} …[truncated]`;
    collected.push(`> ${text.replaceAll('\n', '\n> ')}`);
    used += text.length;
  }
  if (collected.length === 0) return '';
  return `\n\n${PI_COMPACTION_USER_MESSAGES_HEADING}\n${collected.join('\n\n')}\n`
    + '(Real user messages from the compacted region, quoted verbatim except for mandatory secret redaction.)';
}

function serializeForDigest(
  messages: readonly AgentMessage[],
  knownSecrets: readonly string[],
  pristineToolContentByCallId: Readonly<Record<string, string>>,
): string {
  const rows: string[] = [];
  messages.forEach((message, index) => {
    if (isPiLowSignalToolResult(message)) return;
    const record = message as unknown as Record<string, unknown>;
    const callId = typeof record.toolCallId === 'string' ? record.toolCallId : '';
    const pristine = message.role === 'toolResult' && callId
      ? pristineToolContentByCallId[callId]
      : undefined;
    const content = redactPiCompactionText(pristine ?? messageContentText(message), knownSecrets).trim();
    if (!content) return;
    rows.push(`[message ${index + 1}/${messages.length}][${message.role}] ${content}`);
  });
  return rows.join('\n\n');
}

export function buildPiCompactionDigestChunks(input: {
  messages: readonly AgentMessage[];
  knownSecrets?: readonly string[];
  pristineToolContentByCallId?: Readonly<Record<string, string>>;
}): readonly PiCompactionDigestChunk[] {
  const content = serializeForDigest(
    input.messages,
    input.knownSecrets ?? [],
    input.pristineToolContentByCallId ?? {},
  );
  if (!content) return Object.freeze([]);
  const chunkSize = Math.max(
    DIGEST_CHUNK_CHARACTERS,
    Math.ceil(content.length / DIGEST_MAX_CHUNKS),
  );
  const total = Math.min(DIGEST_MAX_CHUNKS, Math.ceil(content.length / chunkSize));
  const chunks = Array.from({ length: total }, (_, index) => {
    const startCharacter = index * chunkSize;
    const endCharacter = Math.min(content.length, (index + 1) * chunkSize);
    const chunkContent = content.slice(startCharacter, endCharacter);
    return Object.freeze({
      ordinal: index + 1,
      total,
      startCharacter,
      endCharacter,
      digest: createHash('sha256').update(chunkContent).digest('hex'),
      content: chunkContent,
    });
  });
  return Object.freeze(chunks);
}

export function renderPiCompactionChunkDigests(input: {
  chunks: readonly PiCompactionDigestChunk[];
  bodies: readonly string[];
  knownSecrets?: readonly string[];
}): string {
  if (input.chunks.length !== input.bodies.length) {
    throw new Error('Every compaction digest chunk must have exactly one digest body.');
  }
  if (input.chunks.length === 0) return '';
  const sections = input.chunks.map((chunk, index) => {
    if (chunk.ordinal !== index + 1 || chunk.total !== input.chunks.length) {
      throw new Error('Compaction digest chunks must be complete and in chronological order.');
    }
    const body = redactPiCompactionText(input.bodies[index], input.knownSecrets ?? []).trim();
    return `### Segment ${chunk.ordinal}/${chunk.total} · ${chunk.digest.slice(0, 16)}\n${body || '[digest unavailable — recover via session_search]'}`;
  });
  return `\n\n${PI_COMPACTION_DIGESTS_HEADING}\n${sections.join('\n\n')}`;
}

export function boundPiCompactionSummaryInput(
  content: string,
  maximumCharacters = SUMMARY_INPUT_MAX_CHARACTERS,
): string {
  if (content.length <= maximumCharacters) return content;
  const markerTemplate = (omitted: number) => (
    `\n\n...[summary input truncated: omitted ${omitted.toLocaleString('en-US')} chars from the middle to keep compression prompt bounded]...\n\n`
  );
  let marker = markerTemplate(content.length);
  let remaining = Math.max(maximumCharacters - marker.length, 0);
  let headCharacters = Math.floor(remaining * 0.45);
  let tailCharacters = remaining - headCharacters;
  marker = markerTemplate(Math.max(content.length - headCharacters - tailCharacters, 0));
  remaining = Math.max(maximumCharacters - marker.length, 0);
  headCharacters = Math.floor(remaining * 0.45);
  tailCharacters = remaining - headCharacters;
  const tail = tailCharacters > 0 ? content.slice(-tailCharacters).trimStart() : '';
  return `${content.slice(0, headCharacters).trimEnd()}${marker}${tail}`;
}

export function buildPiCompactionRecoveryFooter(input: {
  sessionId: string;
  authorizedSessionId: string | null;
  sessionSearchAvailable: boolean;
  compactedMessageCount: number;
}): string {
  if (!input.sessionSearchAvailable || input.authorizedSessionId !== input.sessionId) return '';
  const safeSessionId = input.sessionId.replace(/[^A-Za-z0-9._:-]/gu, '').slice(0, 128);
  if (!safeSessionId) return '';
  return `\n\n${PI_COMPACTION_RECOVERY_HEADING}\n`
    + `The ${Math.max(0, Math.floor(input.compactedMessageCount))} compacted message(s) remain preserved in authorized session history. `
    + 'Recover exact command output, file contents, error text, or other omitted specifics with: '
    + `session_search(query='<keywords>', session_id='${safeSessionId}'). Do not guess when recovery is available.`;
}

export function buildPiCompactionRecoveryArtifacts(input: {
  messages: readonly AgentMessage[];
  sessionId: string;
  authorizedSessionId: string | null;
  sessionSearchAvailable: boolean;
  knownSecrets?: readonly string[];
  pristineToolContentByCallId?: Readonly<Record<string, string>>;
}): PiCompactionRecoveryArtifacts {
  const knownSecrets = input.knownSecrets ?? [];
  const redactedTranscript = serializeForDigest(
    input.messages,
    knownSecrets,
    input.pristineToolContentByCallId ?? {},
  );
  return Object.freeze({
    redactedTranscript,
    anchorIndex: buildPiCompactionAnchorIndex(input.messages, knownSecrets),
    verbatimUserSection: buildPiCompactionVerbatimUserSection(input.messages, knownSecrets),
    digestChunks: buildPiCompactionDigestChunks({
      messages: input.messages,
      knownSecrets,
      pristineToolContentByCallId: input.pristineToolContentByCallId,
    }),
    recoveryFooter: buildPiCompactionRecoveryFooter({
      sessionId: input.sessionId,
      authorizedSessionId: input.authorizedSessionId,
      sessionSearchAvailable: input.sessionSearchAvailable,
      compactedMessageCount: input.messages.length,
    }),
  });
}
