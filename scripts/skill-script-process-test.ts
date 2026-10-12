import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { executeSkillScriptProcess, probeSkillScriptRuntime } from '../app/lib/skills/script-runtime/process';
import { attachSkillScriptBridge, encodeSkillScriptFrame } from '../app/lib/skills/script-runtime/protocol';
import { isSkillScriptError, type SkillScriptDeclaration } from '../app/lib/skills/script-runtime/contracts';

async function listen(server: Server, address: number | string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (typeof address === 'number') server.listen(address, '127.0.0.1', resolve);
    else server.listen(address, resolve);
  });
}
async function close(server: Server): Promise<void> { await new Promise<void>(resolve => server.close(() => resolve())); }

async function main() {
  const fixture = await fs.mkdtemp(path.join(process.cwd(), '.skill-script-process-test-'));
  const packageRoot = path.join(fixture, 'package'), scratchParent = path.join(fixture, 'scratch');
  const foreign = path.join(fixture, 'private/secret.txt'), sibling = path.join(scratchParent, 'other-session/private.txt');
  const unixPath = `/tmp/canvas-skill-${randomUUID()}.sock`;
  let connections = 0, datagrams = 0;
  const tcp = createServer(socket => { connections++; socket.destroy(); });
  const unix = createServer(socket => { connections++; socket.destroy(); });
  const udp = createSocket('udp4'); udp.on('message', () => datagrams++);
  const previousSecret = process.env.CANVAS_SCRIPT_TEST_SECRET;
  process.env.CANVAS_SCRIPT_TEST_SECRET = 'inert-script-fixture-secret';
  try {
    await fs.mkdir(packageRoot); await fs.mkdir(path.dirname(foreign), { recursive: true });
    await fs.mkdir(path.dirname(sibling), { recursive: true });
    await fs.writeFile(foreign, 'private-sentinel'); await fs.writeFile(sibling, 'sibling-sentinel');
    await listen(tcp, 0); await listen(unix, unixPath);
    await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve));
    const tcpPort = (tcp.address() as { port: number }).port, udpPort = (udp.address() as { port: number }).port;
    const baseArgs = { foreign, sibling, tcpPort, udpPort, unixPath };
    const declaration = (kind: 'node' | 'python', file: string): SkillScriptDeclaration => ({
      id: 'fixture', runtime: { kind }, path: file, argumentsSchema: { type: 'object' }, tools: [], outputs: [],
    });
    const nodeSource = `
const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net'),dgram=require('node:dgram');
const sdk=require(process.env.CANVAS_SKILL_BRIDGE_MODULE),args=sdk.arguments();
assert.equal(process.env.CANVAS_SCRIPT_TEST_SECRET,undefined);
assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.NODE_PATH,undefined);
assert.throws(()=>fs.readFileSync(args.foreign));assert.throws(()=>fs.readFileSync(args.sibling));
assert.throws(()=>fs.writeFileSync(__filename,'tamper'));assert.throws(()=>fs.chmodSync(__filename,0));
assert.throws(()=>fs.readdirSync(require('node:path').dirname(args.foreign)));
const failed=(socket,connect)=>new Promise((resolve,reject)=>{socket.once('error',e=>{if(!['EPERM','EACCES'].includes(e.code))reject(e);else resolve();socket.close?.();socket.destroy?.();});connect();});
(async()=>{
 await failed(new net.Socket(),function(){this;});
})();
`;
    // Explicit connector arguments avoid DNS/cache effects and exercise real local endpoints.
    const networkNode = nodeSource.slice(0, nodeSource.indexOf('(async()=>')) + `
(async()=>{
 for(const address of [{host:'127.0.0.1',port:args.tcpPort},{host:'::1',port:args.tcpPort},{path:args.unixPath}]){
   const socket=new net.Socket();await failed(socket,()=>socket.connect(address));
 }
 for(const family of ['udp4','udp6']){const socket=dgram.createSocket(family);await failed(socket,()=>socket.send(Buffer.from('blocked'),args.udpPort,family==='udp4'?'127.0.0.1':'::1'));}
 const description=await sdk.describe('native');assert.equal(description.schemaHandle,'fixture-schema');
 const result=await sdk.call('native',{value:7});assert.equal(result.value,7);
 fs.writeFileSync('result.txt',JSON.stringify({args:true,bridge:true,networkBlocked:true}));
 console.log('node script completed');
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
    const pythonSource = `
import canvas_skill,os,pathlib,socket,errno,json
args=canvas_skill.arguments()
assert 'CANVAS_SCRIPT_TEST_SECRET' not in os.environ and 'PYTHONPATH' not in os.environ
for target in [args['foreign'],args['sibling']]:
 try: pathlib.Path(target).read_text()
 except OSError as error: assert error.errno in (errno.EPERM,errno.EACCES),error
 else: raise AssertionError('private read allowed')
for action in [lambda:pathlib.Path(__file__).write_text('tamper'),lambda:os.chmod(__file__,0)]:
 try: action()
 except OSError as error: assert error.errno in (errno.EPERM,errno.EACCES),error
 else: raise AssertionError('package mutation allowed')
for family,kind,address in [(socket.AF_INET,socket.SOCK_STREAM,('127.0.0.1',args['tcpPort'])),(socket.AF_INET6,socket.SOCK_STREAM,('::1',args['tcpPort'])),(socket.AF_UNIX,socket.SOCK_STREAM,args['unixPath']),(socket.AF_INET,socket.SOCK_DGRAM,('127.0.0.1',args['udpPort'])),(socket.AF_INET6,socket.SOCK_DGRAM,('::1',args['udpPort']))]:
 sock=None
 try:
  sock=socket.socket(family,kind)
  if kind==socket.SOCK_DGRAM: sock.sendto(b'blocked',address)
  else: sock.connect(address)
 except OSError as error: assert error.errno in (errno.EPERM,errno.EACCES),error
 else: raise AssertionError('network allowed')
 finally:
  if sock: sock.close()
assert canvas_skill.describe('native')['schemaHandle']=='fixture-schema'
assert canvas_skill.call('native',{'value':7})['value']==7
pathlib.Path('result.txt').write_text(json.dumps({'args':True,'bridge':True,'networkBlocked':True}))
print('python script completed')
`;
    await fs.writeFile(path.join(packageRoot, 'main.cjs'), networkNode);
    await fs.writeFile(path.join(packageRoot, 'main.py'), pythonSource);
    let validated = 0, requests = 0;
    const revalidate = async () => { validated++; };
    const onRequest = async (raw: unknown) => {
      const request = raw as { id: number; action: string; schemaHandle?: string; arguments?: unknown };
      requests++; assert.equal(request.id, (requests - 1) % 3 + 1);
      if (request.action === 'call') assert.equal(request.schemaHandle, 'fixture-schema');
      return { version: 1, id: request.id, ok: true, data: request.action === 'describe' ? { schemaHandle: 'fixture-schema' } : request.arguments };
    };
    const readiness = await Promise.all(['node', 'python'].map(kind => probeSkillScriptRuntime({ runtime: { kind: kind as 'node' | 'python' } })));
    assert.equal(readiness.every(result => result.available), true, JSON.stringify(readiness));
    for (const kind of ['node', 'python'] as const) {
      const file = kind === 'node' ? 'main.cjs' : 'main.py';
      const result = await executeSkillScriptProcess({ declaration: declaration(kind, file), packageRoot,
        entryPath: path.join(packageRoot, file), scratchParent, arguments: baseArgs, revalidate, onRequest });
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.terminated, false);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.scratchDirectory, 'result.txt'), 'utf8')), { args: true, bridge: true, networkBlocked: true });
      assert.equal(path.dirname(result.scratchDirectory), await fs.realpath(scratchParent));
      await fs.rm(result.scratchDirectory, { recursive: true });
    }
    assert.equal(requests, 6); assert.equal(validated >= 12, true);
    assert.equal(connections, 0); assert.equal(datagrams, 0);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'private-sentinel');
    assert.equal((await probeSkillScriptRuntime({ runtime: { kind: 'node', minimumVersion: '999.0.0' } })).code, 'SCRIPT_RUNTIME_UNAVAILABLE');

    const options = { declaration: declaration('node', 'main.cjs'), packageRoot, entryPath: path.join(packageRoot, 'main.cjs'), scratchParent,
      arguments: {}, revalidate, onRequest };
    await fs.writeFile(options.entryPath, "const sdk=require(process.env.CANVAS_SKILL_BRIDGE_MODULE);sdk.describe('ready').then(()=>setInterval(()=>{},1000));");
    const controller = new AbortController(); let abortTimer: ReturnType<typeof setTimeout> | undefined;
    try { await assert.rejects(executeSkillScriptProcess({ ...options, signal: controller.signal, onRequest: async raw => {
      abortTimer = setTimeout(() => controller.abort(), 100);
      return { version: 1, id: (raw as { id: number }).id, ok: true, data: { schemaHandle: 'ready' } };
    } }), error => isSkillScriptError(error) && error.code === 'SCRIPT_ABORTED'); }
    finally { if (abortTimer) clearTimeout(abortTimer); }
    await fs.writeFile(options.entryPath, "setInterval(()=>{},1000)");
    let revokeChecks = 0;
    try { await assert.rejects(executeSkillScriptProcess({ ...options, revalidate: async () => { if (++revokeChecks >= 3) throw new Error('revoked'); } }),
      error => isSkillScriptError(error) && error.code === 'SCRIPT_ACCESS_DENIED'); }
    finally { assert.equal(revokeChecks >= 3, true); }

    await fs.writeFile(options.entryPath, "const fs=require('fs');let header=Buffer.alloc(4);header.writeUInt32BE(65537);fs.writeSync(3,header);setInterval(()=>{},1000)");
    await assert.rejects(executeSkillScriptProcess(options), error => isSkillScriptError(error) && error.code === 'SCRIPT_PROTOCOL_INVALID');
    await fs.writeFile(options.entryPath, "process.stdout.write('x'.repeat(300000));setInterval(()=>{},1000)");
    await assert.rejects(executeSkillScriptProcess(options), error => isSkillScriptError(error) && error.code === 'SCRIPT_LIMIT_EXCEEDED');
    assert.deepEqual((await fs.readdir(scratchParent)).sort(), ['other-session']);

    await fs.writeFile(options.entryPath, "const sdk=require(process.env.CANVAS_SKILL_BRIDGE_MODULE);(async()=>{for(let i=0;i<32;i++)await sdk.describe('native');})();");
    await assert.rejects(executeSkillScriptProcess({ ...options, onRequest: async raw => ({ version: 1,
      id: (raw as { id: number }).id, ok: true, data: { padding: 'x'.repeat(60000) } }) }),
    error => isSkillScriptError(error) && error.code === 'SCRIPT_PROTOCOL_INVALID');

    await fs.writeFile(options.entryPath, "const fs=require('fs');fs.writeFileSync('result.txt',String(process.pid));setTimeout(()=>{},20)");
    const simultaneous = await Promise.all([executeSkillScriptProcess(options), executeSkillScriptProcess(options)]);
    assert.notEqual(simultaneous[0].scratchDirectory, simultaneous[1].scratchDirectory);
    for (const result of simultaneous) { assert.equal(result.exitCode, 0); await fs.rm(result.scratchDirectory, { recursive: true }); }

    await fs.writeFile(options.entryPath, `
const cp=require('child_process'),fs=require('fs');
const source="const fs=require('fs');fs.writeFileSync('child-pid.txt',String(process.pid));setTimeout(()=>fs.writeFileSync('late.txt','escaped'),250);setInterval(()=>{},1000)";
const denied=e=>{if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;fs.writeFileSync('child-denied.txt','denied')};
try{const child=cp.spawn(process.execPath,['-e',source],{stdio:'inherit'});
 child.once('error',denied);
 child.once('spawn',()=>{const interval=setInterval(()=>{if(fs.existsSync('child-pid.txt')){clearInterval(interval);process.exit(0)}},10)});
}catch(e){denied(e)}
`);
    const descendants = await executeSkillScriptProcess(options);
    assert.equal(descendants.exitCode, 0, descendants.stderr);
    assert.equal(await fs.readFile(path.join(descendants.scratchDirectory, 'child-denied.txt'), 'utf8'), 'denied');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await fs.access(path.join(descendants.scratchDirectory, 'late.txt')).then(() => true, () => false), false);
    await fs.rm(descendants.scratchDirectory, { recursive: true });

    await fs.writeFile(options.entryPath, "const sdk=require(process.env.CANVAS_SKILL_BRIDGE_MODULE);(async()=>{try{await sdk.call('native',{})}catch{};await sdk.call('native',{});})();");
    let unknownCalls = 0;
    const unknown = await executeSkillScriptProcess({ ...options, onRequest: async raw => {
      const request = raw as { id: number; action: string };
      if (request.action === 'describe') return { version: 1, id: request.id, ok: true, data: { schemaHandle: 'unknown-schema' } };
      unknownCalls++; return { version: 1, id: request.id, ok: false, error: { code: 'SCRIPT_OUTCOME_UNKNOWN', message: 'Unknown outcome.', outcome: 'unknown' }, terminate: true };
    } });
    assert.equal(unknown.terminated, true); assert.equal(unknownCalls, 1);
    await fs.rm(unknown.scratchDirectory, { recursive: true });

    // A pending watcher may finish after the interpreter exits. It must not
    // signal an old PID, invoke onStop, or schedule another check after success.
    await fs.writeFile(options.entryPath, "setTimeout(()=>{},650)");
    let finishWatcher!: () => void, watcherPending = false, checks = 0, lateStops = 0;
    const delayed = await executeSkillScriptProcess({ ...options, revalidate: async () => {
      checks++;
      if (checks === 3) {
        watcherPending = true;
        await new Promise<void>(resolve => { finishWatcher = resolve; });
        throw new Error('late revocation');
      }
    }, onStop: () => { lateStops++; } });
    assert.equal(watcherPending, true); assert.equal(delayed.exitCode, 0); assert.equal(delayed.terminated, false);
    const completedChecks = checks;
    finishWatcher(); await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(lateStops, 0); assert.equal(checks, completedChecks);
    await fs.rm(delayed.scratchDirectory, { recursive: true });

    if (process.env.CANVAS_SCRIPT_PROCESS_TIMEOUT_TEST === '1') {
      await fs.writeFile(options.entryPath, "setInterval(()=>{},1000)");
      const startedAt = Date.now(); let stopReason = '';
      await assert.rejects(executeSkillScriptProcess({ ...options, onStop: reason => { stopReason = reason; } }),
        error => isSkillScriptError(error) && error.code === 'SCRIPT_TIMEOUT');
      assert.equal(stopReason, 'SCRIPT_TIMEOUT'); assert.equal(Date.now() - startedAt >= 60_000, true);
      assert.deepEqual((await fs.readdir(scratchParent)).sort(), ['other-session']);
      console.log('skill-script-process-test: actual 60-second wall timeout and cleanup PASS');
    }

    // Parent framing enforces monotonically increasing IDs and one in-flight request.
    for (const packets of [[{ version: 1, id: 2, action: 'describe', alias: 'native' }],
      [{ version: 1, id: 1, action: 'describe', alias: 'native' }, { version: 1, id: 2, action: 'describe', alias: 'native' }]]) {
      const requestStream = new PassThrough(), responseStream = new PassThrough(); let calls = 0, stopped = false;
      const bridge = attachSkillScriptBridge({ requests: requestStream, responses: responseStream,
        onRequest: async () => { calls++; return {}; }, terminate: () => { stopped = true; } });
      requestStream.write(Buffer.concat(packets.map(encodeSkillScriptFrame)));
      assert.equal(stopped, true); assert.equal(calls, 0); bridge.close();
    }
    console.log(`skill-script-process-test: PASS ${process.platform}/${process.arch}; exact-package reads, immutable scripts, Node/Python RPC, IPv4/IPv6/UDP/UNIX denial, process creation denied, scratch, abort/revoke/protocol/log limits, unknown stop`);
  } finally {
    if (previousSecret === undefined) delete process.env.CANVAS_SCRIPT_TEST_SECRET; else process.env.CANVAS_SCRIPT_TEST_SECRET = previousSecret;
    await Promise.all([close(tcp), close(unix)]); await new Promise<void>(resolve => udp.close(resolve));
    await fs.rm(fixture, { recursive: true, force: true });
  }
}
void main();
