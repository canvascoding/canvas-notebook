'use strict';

// All transport is over inherited descriptors. This module contains no credentials or network client.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Unbundled .cjs SDK must support require(CANVAS_SKILL_BRIDGE_MODULE) in CommonJS scripts.
const fs = require('node:fs');
const MAX_FRAME = 64 * 1024;
let initialArguments, nextId = 1, waiting = false, closed = false;

function readExact(fd, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, null);
    if (!count) throw new Error('Canvas script arguments are unavailable.');
    offset += count;
  }
  return bytes;
}

function argumentsValue() {
  if (initialArguments === undefined) {
    const length = readExact(0, 4).readUInt32BE(0);
    if (!length || length > MAX_FRAME) throw new Error('Canvas script arguments exceed their limit.');
    initialArguments = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExact(0, length)));
    if (!initialArguments || typeof initialArguments !== 'object' || Array.isArray(initialArguments)) throw new Error('Canvas script arguments must be an object.');
  }
  return initialArguments;
}

function readExactAsync(fd, size) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    const next = () => fs.read(fd, bytes, offset, size - offset, null, (error, count) => {
      if (error) return reject(error);
      if (!count) return reject(new Error('The Canvas script bridge is closed.'));
      offset += count;
      if (offset === size) resolve(bytes); else next();
    });
    next();
  });
}

async function request(action, alias, extra) {
  if (closed || waiting) throw new Error('The Canvas script bridge is closed or busy.');
  if (typeof alias !== 'string' || !alias.length || alias.length > 128) throw new Error('The Canvas tool alias is invalid.');
  const id = nextId++;
  const bytes = Buffer.from(JSON.stringify({ version: 1, id, action, alias, ...extra }), 'utf8');
  if (!bytes.length || bytes.length > MAX_FRAME) throw new Error('The Canvas script bridge request exceeds its limit.');
  const frame = Buffer.alloc(4 + bytes.length); frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4);
  waiting = true;
  try {
    let offset = 0;
    while (offset < frame.length) offset += fs.writeSync(3, frame, offset, frame.length - offset);
    const size = (await readExactAsync(4, 4)).readUInt32BE(0);
    if (!size || size > MAX_FRAME) throw new Error('Canvas script bridge frame is invalid.');
    const response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readExactAsync(4, size)));
    if (response.version !== 1 || response.id !== id || typeof response.ok !== 'boolean') throw new Error('Canvas script bridge response is invalid.');
    if (response.terminate === true || response.error?.outcome === 'unknown') closed = true;
    if (!response.ok) {
      const error = new Error(response.error?.message || 'The Canvas tool call failed.');
      error.code = response.error?.code; error.outcome = response.error?.outcome;
      throw error;
    }
    return response.data;
  } finally { waiting = false; }
}

async function describe(alias) { return request('describe', alias); }
async function call(alias, args = {}) {
  const description = await describe(alias);
  if (!description || typeof description.schemaHandle !== 'string') throw new Error('The Canvas tool schema handle is unavailable.');
  return request('call', alias, { schemaHandle: description.schemaHandle, arguments: args });
}

module.exports = Object.freeze({ arguments: argumentsValue, describe, call });
