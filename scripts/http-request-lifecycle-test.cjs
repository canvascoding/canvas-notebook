/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { guardHttpRequestLifecycle } = require('../server/http-request-lifecycle');

const fixture = `
const http = require('node:http');
const net = require('node:net');
const { guardHttpRequestLifecycle } = require('./server/http-request-lifecycle');
let accept;
const accepted = new Promise(resolve => accept = resolve);
let closed;
const requestClosed = new Promise(resolve => closed = resolve);
const server = http.createServer((req, res) => {
  if (process.argv[1] === 'guarded') guardHttpRequestLifecycle(req, res);
  if (req.url === '/health') { res.end('alive'); return; }
  const frameworkListener = () => {};
  req.on('error', frameworkListener);
  // A socket-close cleanup can remove the framework listener after Node
  // queued the request error, but before the next-tick emission delivers it.
  req.socket.once('close', () => process.nextTick(() => req.removeListener('error', frameworkListener)));
  req.once('close', closed);
  accept();
});
server.listen(0, '127.0.0.1', async () => {
  const client = net.connect(server.address().port, '127.0.0.1');
  client.on('error', () => {});
  client.write('POST /session HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: 1000\\r\\n\\r\\nabc');
  await accepted;
  client.destroy();
  await requestClosed;
  http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/health' }, res => {
    let body = ''; res.on('data', chunk => body += chunk);
    res.on('end', () => { process.stdout.write(body); server.close(); });
  });
});
`;
const run = mode => spawnSync(process.execPath, ['-e', fixture, mode], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
const unguarded = run('unguarded');
assert.equal(unguarded.status, 1, 'an incomplete real TCP request reproduces the uncaught server failure');
assert.match(unguarded.stderr, /ECONNRESET/);
const guarded = run('guarded');
assert.equal(guarded.status, 0, guarded.stderr);
assert.equal(guarded.stdout, 'alive', 'the same HTTP server still answers after request cancellation');

const req = new EventEmitter();
req.aborted = false;
const reports = [];
let destroyed = 0;
const res = { destroyed: false, destroy() { this.destroyed = true; destroyed++; } };
guardHttpRequestLifecycle(req, res, (...args) => reports.push(args));
let frameworkError;
req.on('error', error => frameworkError = error);
const failure = new Error('Unexpected request stream failure');
req.emit('error', failure);
assert.equal(frameworkError, failure, 'the framework still receives request errors');
assert.equal(reports[0][1], failure, 'unexpected stream failures stay observable');
assert.equal(destroyed, 1);
req.aborted = true;
req.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
assert.equal(reports.length, 1, 'a known transport cancellation is not an application error');
assert.equal(destroyed, 1, 'an already closed response is not destroyed again');
console.log('HTTP request lifecycle: real TCP abort reproduced without guard; guarded server survives and preserves framework errors.');
