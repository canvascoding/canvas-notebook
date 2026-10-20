import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 32;
const MAX_RECORD_BYTES = 16 * 1024;
const KEY = Symbol.for('canvas.chat-extension-model-observer.v1');
const REQUEST_PATH = '/v1/chat/completions';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const privateFile = stat => stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600;
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink;

async function readPrivate(file, maximum) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!privateFile(before) || before.size < 1 || before.size > maximum) throw new Error('guard');
    const bytes = await handle.readFile();
    if (bytes.length !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, await fs.lstat(file))) throw new Error('guard');
    return bytes;
  } finally { await handle.close(); }
}

async function ownedScope() {
  const env = process.env, nonce = env.PLUGIN_EXTENSION_E2E_NONCE, root = env.PLUGIN_EXTENSION_E2E_ROOT;
  if (!/^[a-f0-9]{32}$/u.test(nonce ?? '') || !root || !path.isAbsolute(root) || !path.basename(root).startsWith('canvas-plugin-extension-e2e-')
    || await fs.realpath(root) !== root) throw new Error('guard');
  const stat = await fs.lstat(root), dataRoot = path.join(root, 'data');
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
    || env.DATA !== dataRoot || env.CANVAS_DATA_ROOT !== dataRoot || await fs.realpath(dataRoot) !== dataRoot
    || env.BASE_URL !== 'http://127.0.0.1:3001' || env.PLUGIN_EXTENSION_E2E_FIXTURE !== path.join(root, 'fixture.json')
    || env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE !== path.join(root, 'recovery.json')) throw new Error('guard');
  const databaseName = `canvas_plugin_extension_test_${nonce}`, database = new URL(env.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1' || database.port !== '55433'
    || database.pathname !== `/${databaseName}` || database.search || database.hash) throw new Error('guard');
  const marker = (await readPrivate(path.join(root, '.fixture-owner'), 48)).toString('utf8');
  const receipt = JSON.parse((await readPrivate(path.join(root, 'recovery.json'), 65536)).toString('utf8'));
  if (!/^[a-f0-9]{48}$/u.test(marker) || receipt.version !== 1 || receipt.nonce !== nonce || receipt.fixtureRoot !== root
    || receipt.dataRoot !== dataRoot || receipt.databaseName !== databaseName || receipt.ownerMarker !== marker
    || receipt.rootDevice !== String(stat.dev) || receipt.rootInode !== String(stat.ino) || receipt.createAcknowledged !== true
    || receipt.databaseDropped !== false || receipt.uncertain !== false || !['build', 'browser'].includes(receipt.phase)
    || typeof receipt.actorId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(receipt.actorId)
    || receipt.repo !== await fs.realpath(process.cwd()) || env.CANVAS_APP_ROOT !== receipt.repo) throw new Error('guard');
  return { root, nonce, stat };
}

function requestTarget(input, init) {
  let url, method = 'GET';
  if (typeof input === 'string') url = new URL(input);
  else if (input instanceof URL) url = new URL(URL.prototype.toString.call(input));
  else if (input instanceof Request) {
    url = new URL(Object.getOwnPropertyDescriptor(Request.prototype, 'url').get.call(input));
    method = Object.getOwnPropertyDescriptor(Request.prototype, 'method').get.call(input);
  } else return false;
  if (init != null) {
    const descriptor = Object.getOwnPropertyDescriptor(init, 'method');
    if (descriptor && !('value' in descriptor)) return false;
    if (descriptor?.value !== undefined) method = descriptor.value;
  }
  return typeof method === 'string' && method.toUpperCase() === 'POST' && url.protocol === 'http:' && url.hostname === '127.0.0.1'
    && url.port === '11434' && url.pathname === REQUEST_PATH && !url.search && !url.hash && !url.username && !url.password;
}

async function requestBytes(input, init) {
  const descriptor = init == null ? undefined : Object.getOwnPropertyDescriptor(init, 'body');
  if (descriptor && !('value' in descriptor)) return { reason: 'unsupported_body' };
  const body = descriptor?.value;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_BYTES || Buffer.byteLength(body) > MAX_BODY_BYTES) return { reason: 'body_limit' };
    return { bytes: Buffer.from(body) };
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_BODY_BYTES) return { reason: 'body_limit' };
    return { bytes: Buffer.from(body) };
  }
  if (descriptor || !(input instanceof Request)) return { reason: 'unsupported_body' };
  // Only a bounded clone is read. The original request remains untouched and
  // fetch never waits for this diagnostic branch, including stream cancellation.
  const clone = Request.prototype.clone.call(input);
  if (!clone.body) return { reason: 'unsupported_body' };
  const reader = clone.body.getReader(), chunks = [];
  let total = 0, timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 1000); timer.unref?.(); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if ('timeout' in part) return { reason: 'body_timeout' };
      if (part.done) return { bytes: Buffer.concat(chunks, total) };
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) return { reason: 'body_limit' };
      chunks.push(Buffer.from(part.value));
    }
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

function metadata(bytes) {
  const body = JSON.parse(bytes.toString('utf8'));
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !Array.isArray(body.tools ?? [])) return { observation: 'skipped', reason: 'invalid_shape' };
  const instructions = body.messages.filter(message => message && ['system', 'developer'].includes(message.role)).map(message => ({ role: message.role,
    content: typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '' }));
  const text = instructions.map(message => message.content).join('\n'), names = (body.tools ?? []).map(tool => tool?.function?.name ?? tool?.name);
  return { observation: 'captured', bodyBytes: bytes.length, bodySHA256: sha(bytes), instructionsSHA256: sha(JSON.stringify(instructions)),
    hasExtensionContextMarker: text.includes('<!-- canvas-effective-extensions:v1 -->'),
    hasMetadataDiscoveryRecipe: text.includes('Permitted local metadata discovery:') && text.includes('search_canvas_extensions')
      && text.includes('"action":"describe"') && text.includes('"action":"call"'),
    hasInternalLookupGuidance: text.includes('Before answering a request that depends on internal or workspace-specific')
      && text.includes('Generic assumptions do not establish internal criteria'),
    model: typeof body.model === 'string' && /^[A-Za-z0-9._:/@+-]{1,128}$/u.test(body.model) ? body.model : '[unavailable]',
    toolCount: names.length, toolNames: names.slice(0, 128).filter(name => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(name)),
    toolNamesTruncated: names.length > 128, messageCount: body.messages.length };
}

/** Optional host preload. Other test modes and ordinary imports do nothing. */
export async function initializeChatExtensionModelObserver() {
  if (process.env.CANVAS_CHAT_MODEL_E2E !== '1' || process.env.CANVAS_PLUGIN_EXTENSION_E2E !== '1') return { installed: false, reason: 'inactive' };
  if (globalThis[KEY]) return { installed: globalThis.fetch === globalThis[KEY].wrapper, reason: 'already_initialized' };
  let scope, output, file;
  try {
    scope = await ownedScope();
    output = await fs.open(path.join(scope.root, 'model-wire-observations.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    file = await output.stat();
    if (!privateFile(file)) throw new Error('guard');
    await output.close(); output = undefined;
  } catch {
    await output?.close().catch(() => {});
    console.warn('[ChatModelObserver] Not installed: owned scope unavailable.');
    return { installed: false, reason: 'guard_rejected' };
  }
  const original = globalThis.fetch;
  let sequence = 0, writes = Promise.resolve(), disabled = false;
  const append = async record => {
    if (disabled) return;
    let handle;
    try {
      const line = `${JSON.stringify(record)}\n`, bytes = Buffer.byteLength(line);
      const target = path.join(scope.root, 'model-wire-observations.jsonl');
      handle = await fs.open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      const root = await fs.lstat(scope.root), current = await fs.lstat(target), opened = await handle.stat();
      if (root.dev !== scope.stat.dev || root.ino !== scope.stat.ino || root.uid !== scope.stat.uid || (root.mode & 0o777) !== 0o700
        || !privateFile(current) || !privateFile(opened) || current.dev !== file.dev || current.ino !== file.ino || opened.ino !== file.ino
        || opened.dev !== file.dev || opened.size + bytes > MAX_RECORDS * MAX_RECORD_BYTES) throw new Error('guard');
      if (bytes > MAX_RECORD_BYTES) throw new Error('record_limit');
      await handle.writeFile(line);
    } catch { disabled = true; console.warn('[ChatModelObserver] Observation storage unavailable.'); }
    finally { await handle?.close().catch(() => {}); }
  };
  const wrapper = function (input, init) {
    try {
      if (!disabled && sequence < MAX_RECORDS && process.env.CANVAS_CHAT_MODEL_E2E === '1' && process.env.CANVAS_PLUGIN_EXTENSION_E2E === '1'
        && process.env.PLUGIN_EXTENSION_E2E_NONCE === scope.nonce && process.env.PLUGIN_EXTENSION_E2E_ROOT === scope.root && requestTarget(input, init)) {
        const number = ++sequence;
        const observation = requestBytes(input, init).then(result => result.bytes ? metadata(result.bytes) : { observation: 'skipped', reason: result.reason })
          .catch(() => ({ observation: 'failed', reason: 'diagnostic_error' }));
        writes = writes.then(async () => append({ version: 1, sequence: number, requestPath: REQUEST_PATH, ...await observation })).catch(() => {});
      }
    } catch { /* Diagnostics must never alter the original fetch invocation or initiate a retry. */ }
    return Reflect.apply(original, this, arguments);
  };
  globalThis[KEY] = { wrapper };
  globalThis.fetch = wrapper;
  return { installed: true };
}

if (process.env.CANVAS_CHAT_MODEL_E2E === '1' && process.env.CANVAS_PLUGIN_EXTENSION_E2E === '1') await initializeChatExtensionModelObserver();
