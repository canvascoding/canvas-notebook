import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  AgentShellSandboxError,
  buildAgentShellSandboxLaunch,
  executeAgentSandboxedCommand,
} from '../app/lib/pi/agent-shell-sandbox';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { ensureAgentRuntimeTempDir } from '../app/lib/pi/agent-runtime-temp';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function main() {
  // Keep every test fixture in this worktree. No app stack or container needed.
  const fixture = await fs.mkdtemp(path.join(process.cwd(), '.agent-shell-sandbox-test-'));
  const previousData = process.env.DATA;
  const previousCanvasData = process.env.CANVAS_DATA_ROOT;
  const workspace = path.join(fixture, 'workspace');
  const data = path.join(fixture, 'data');
  const marker = 'original Word document bytes';
  process.env.DATA = data;
  process.env.CANVAS_DATA_ROOT = data;

  try {
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(data, { recursive: true });
    await fs.mkdir(path.join(workspace, 'empty-directory'));
    await fs.writeFile(path.join(workspace, 'original.docx'), marker);
    await fs.symlink(path.join(workspace, 'original.docx'), path.join(workspace, 'document-alias.docx'));

    const context: AgentExecutionContext = {
      userId: 'sandbox-user', sessionId: 'sandbox-session', agentId: 'office-agent',
      workspaceId: 'sandbox-workspace', workspaceType: 'team', workspaceName: 'Sandbox test',
      organizationId: 'sandbox-org', customerId: null, projectId: null,
      workspaceRoot: workspace, workspaceRootRelativePath: null,
      canWrite: true, canDelete: true, canShare: false, legacy: false,
    };
    const scratch = await ensureAgentRuntimeTempDir(context);
    const canonicalScratch = await fs.realpath(scratch);
    await fs.symlink(workspace, path.join(scratch, 'workspace-link'));
    await fs.writeFile(path.join(scratch, 'replacement.docx'), 'replacement');

    const run = (command: string, signal?: AbortSignal) => executeAgentSandboxedCommand(command, {
      context,
      env: { NODE_ENV: 'test', PATH: process.env.PATH, LANG: 'en_US.UTF-8', CANVAS_TEST_VALUE: 'preserved value' },
      signal,
    });

    assert.throws(() => buildAgentShellSandboxLaunch({
      platform: 'win32', scratchDirectory: scratch, command: 'echo unsafe', appRoot: process.cwd(),
    }), AgentShellSandboxError);
    const linuxLaunch = buildAgentShellSandboxLaunch({
      platform: 'linux', scratchDirectory: scratch, command: 'echo safe', appRoot: process.cwd(),
    });
    assert.equal(linuxLaunch.executable, '/usr/bin/python3');
    assert.deepEqual(linuxLaunch.args.slice(0, 2), ['-I', '-B']);
    assert.equal(linuxLaunch.args[2], path.join(process.cwd(), 'scripts/runtime/agent-shell-sandbox.py'));

    await assert.rejects(executeAgentSandboxedCommand('echo must-not-run', { context: null, env: { NODE_ENV: 'test' } }),
      /workspace-bound session/);
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      await assert.rejects(run('echo must-not-run'), /isolation is unavailable/);
      console.log('agent-shell-sandbox-test: unsupported platform correctly fails closed');
      return;
    }

    // Check the actual emitted seccomp bytecode for both supported Linux
    // ABIs even on macOS. Native Linux syscall enforcement is tested below
    // when this same suite runs on Linux, not inferred from these assertions.
    const linuxPolicySource = `
import ctypes, errno, importlib.util
spec = importlib.util.spec_from_file_location('sandbox', ${JSON.stringify(linuxLaunch.args[2])})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Capture:
  def prctl(self, option, mode, pointer, *rest):
    assert (option, mode) == (22, 2)
    program = ctypes.cast(pointer, ctypes.POINTER(module.SockFprog)).contents
    self.instructions = [(item.code, item.jt, item.jf, item.k) for item in program.filter[:program.len]]
    return 0
def evaluate(instructions, architecture, number, arguments=()):
  index, accumulator = 0, 0
  while index < len(instructions):
    code, yes, no, constant = instructions[index]
    if code == 0x20:
      words = {0: number, 4: architecture}
      words.update({16 + offset * 8: value & 0xFFFFFFFF for offset, value in enumerate(arguments)})
      accumulator = words[constant]
    elif code == 0x54:
      accumulator &= constant
    elif code == 0x15:
      index += yes if accumulator == constant else no
    elif code == 0x35:
      index += yes if accumulator >= constant else no
    elif code == 0x06:
      return constant
    else:
      raise AssertionError('Unsupported BPF instruction')
    index += 1
  raise AssertionError('BPF fell through without a decision')
for machine, architecture, write, chmod, ioctl, opens in [('x86_64', 0xC000003E, 1, 90, 16, [(2, 1), (257, 2)]), ('aarch64', 0xC00000B7, 64, 52, 29, [(56, 2)])]:
  capture = Capture()
  module.restrict_metadata(capture, machine)
  check = lambda syscall, *arguments: evaluate(capture.instructions, architecture, syscall, arguments)
  assert check(write) == 0x7FFF0000
  for syscall in (chmod, 425, 452, 463, 466, 469):
    assert check(syscall) == 0x00050000 | errno.EPERM, (machine, syscall)
  assert check(ioctl, 0, 0x541B) == 0x7FFF0000  # FIONREAD
  assert check(ioctl, 0, 0x40086602) == 0x00050000 | errno.EPERM  # FS_IOC_SETFLAGS
  assert check(437) == 0x00050000 | errno.ENOSYS  # openat2 flags are indirect.
  for syscall, flag_argument in opens:
    for access in range(4):
      for truncate in (0, 0x200):
        for extra in (0, 0x80000, 0x40):  # CLOEXEC/CREAT cannot bypass the guard.
          arguments = [0] * (flag_argument + 1)
          arguments[flag_argument] = access | truncate | extra
          expected = (0x00050000 | errno.EPERM) if truncate and access in (0, 3) else 0x7FFF0000
          assert check(syscall, *arguments) == expected, (machine, syscall, arguments)
  assert check(473) == 0x00050000 | errno.ENOSYS
  assert check(0x40000000 + write) == 0x00050000 | errno.ENOSYS
  assert evaluate(capture.instructions, 0, write) == 0x80000000
class Probe:
  restype = None
  def __init__(self, result):
    self.result = result
    self.calls = []
  def __call__(self, *arguments):
    self.calls.append(arguments)
    ctypes.set_errno(errno.EOPNOTSUPP)
    return self.result
class FakeLibc:
  def __init__(self, result):
    self.syscall = Probe(result)
module.platform.machine = lambda: 'x86_64'
for result, expected in [(2, RuntimeError), (-1, OSError)]:
  fake = FakeLibc(result)
  module.ctypes.CDLL = lambda *args, **kwargs: fake
  try:
    module.confine(${JSON.stringify(canonicalScratch)})
  except expected:
    pass
  else:
    raise AssertionError('Unsupported Landlock did not fail closed')
  assert fake.syscall.calls == [(444, 0, 0, 1)]
print('Linux seccomp ABI and syscall decisions verified')
`;
    const linuxPolicy = await run(`/usr/bin/python3 -I -B -c ${shellQuote(linuxPolicySource)}`);
    assert.match(linuxPolicy.stdout, /Linux seccomp ABI and syscall decisions verified/);

    const pythonSource = `
import ctypes, errno, json, os, pathlib, platform, sys, zipfile
workspace = pathlib.Path.cwd()
scratch = pathlib.Path(os.environ['CANVAS_AGENT_TEMP_DIR'])
source = workspace / 'original.docx'
assert source.read_text() == ${JSON.stringify(marker)}
assert os.environ['CANVAS_TEST_VALUE'] == 'preserved value'
assert os.environ['HOME'] == str(scratch)
assert os.environ['TMPDIR'] == str(scratch)
assert os.environ['PYTHONPYCACHEPREFIX'].startswith(str(scratch) + '/')
attempts = {
  'overwrite': lambda: source.write_text('damaged'),
  'append': lambda: source.open('a').write('damaged'),
  'truncate': lambda: os.truncate(source, 0),
  'readonly_truncate': lambda: os.open(source, os.O_RDONLY | os.O_TRUNC),
  'rename': lambda: source.rename(workspace / 'renamed.docx'),
  'remove': lambda: source.unlink(),
  'create': lambda: (workspace / 'new.docx').write_text('new'),
  'mkdir': lambda: (workspace / 'new-directory').mkdir(),
  'rmdir': lambda: (workspace / 'empty-directory').rmdir(),
  'symlink_create': lambda: (workspace / 'new-link').symlink_to(scratch),
  'symlink_workspace': lambda: (workspace / 'document-alias.docx').write_text('damaged'),
  'symlink_scratch': lambda: (scratch / 'workspace-link' / 'original.docx').write_text('damaged'),
  'hardlink_to_scratch': lambda: os.link(source, scratch / 'linked.docx'),
  'replace_from_scratch': lambda: os.replace(scratch / 'replacement.docx', source),
  'chmod': lambda: source.chmod(0),
  'utime': lambda: os.utime(source, (0, 0)),
}
for name, action in attempts.items():
  try:
    action()
  except OSError as error:
    assert error.errno in (errno.EACCES, errno.EPERM, errno.EXDEV, errno.EROFS), (name, error)
  else:
    raise AssertionError('Sandbox permitted workspace mutation: ' + name)
  assert source.read_text() == ${JSON.stringify(marker)}, name

linux_open_probes = 0
if sys.platform == 'linux':
  libc = ctypes.CDLL(None, use_errno=True)
  libc.syscall.restype = ctypes.c_long
  opens = [(257 if platform.machine() == 'x86_64' else 56, [-100, os.fsencode(source)])]
  if platform.machine() == 'x86_64':
    opens.append((2, [os.fsencode(source)]))
  for number, arguments in opens:
    for access in (os.O_RDONLY, 3):
      result = libc.syscall(number, *arguments, access | os.O_TRUNC | os.O_CLOEXEC, 0)
      assert result == -1 and ctypes.get_errno() == errno.EPERM, (number, access, result)
      assert source.read_text() == ${JSON.stringify(marker)}, (number, access)
      linux_open_probes += 1
  class OpenHow(ctypes.Structure):
    _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]
  for flags in (os.O_RDONLY, os.O_RDONLY | os.O_TRUNC):
    how = OpenHow(flags, 0, 0)
    result = libc.syscall(437, -100, os.fsencode(source), ctypes.byref(how), ctypes.sizeof(how))
    assert result == -1 and ctypes.get_errno() == errno.ENOSYS, result
    assert source.read_text() == ${JSON.stringify(marker)}, flags
    linux_open_probes += 1

# Real Python ZIP output reproduces the filesystem work of DOCX libraries.
with zipfile.ZipFile(scratch / 'working.docx', 'w', zipfile.ZIP_DEFLATED) as archive:
  archive.writestr('[Content_Types].xml', '<Types/>')
  archive.writestr('word/document.xml', '<document><p>Draft</p></document>')
with zipfile.ZipFile(scratch / 'working.docx') as archive:
  assert archive.testzip() is None
  assert archive.read('word/document.xml') == b'<document><p>Draft</p></document>'
(scratch / 'created-directory').mkdir()
(scratch / 'created-directory' / 'one').write_text('scratch')
(scratch / 'created-directory' / 'one').rename(scratch / 'created-directory' / 'two')
(scratch / 'created-directory' / 'two').unlink()
(scratch / 'created-directory').rmdir()
print(json.dumps({'blocked': list(attempts), 'docx': str(scratch / 'working.docx'), 'linuxOpenProbes': linux_open_probes}))
`;
    const python = await run(`/usr/bin/python3 -c ${shellQuote(pythonSource)}`);
    const pythonResult = JSON.parse(python.stdout);
    assert.equal(pythonResult.blocked.length, 16);
    assert.equal(pythonResult.linuxOpenProbes, process.platform === 'linux' ? (process.arch === 'x64' ? 6 : 4) : 0);
    assert.equal(pythonResult.docx, path.join(canonicalScratch, 'working.docx'));
    assert.equal((await fs.stat(path.join(scratch, 'working.docx'))).size > 0, true);

    const nodeSource = `
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const target = path.join(process.cwd(), 'original.docx');
const scratch = process.env.CANVAS_AGENT_TEMP_DIR;
const attempts = {
  overwrite: () => fs.writeFileSync(target, 'damaged'),
  append: () => fs.appendFileSync(target, 'damaged'),
  truncate: () => fs.truncateSync(target, 0),
  remove: () => fs.unlinkSync(target),
  rename: () => fs.renameSync(target, target + '.renamed'),
  copy: () => fs.copyFileSync(path.join(scratch, 'working.docx'), target),
  link: () => fs.linkSync(target, path.join(scratch, 'node-link.docx')),
  symlink: () => fs.writeFileSync(path.join(scratch, 'workspace-link', 'original.docx'), 'damaged'),
};
for (const [name, operation] of Object.entries(attempts)) {
  assert.throws(operation, error => ['EACCES', 'EPERM', 'EXDEV', 'EROFS'].includes(error.code), name);
  assert.equal(fs.readFileSync(target, 'utf8'), ${JSON.stringify(marker)});
}
fs.writeFileSync(path.join(scratch, 'node-output.txt'), 'Node scratch output');
process.stdout.write(JSON.stringify(Object.keys(attempts)));
process.stderr.write('stderr preserved');
`;
    const node = await run(`${shellQuote(process.execPath)} -e ${shellQuote(nodeSource)}`);
    assert.equal(JSON.parse(node.stdout).length, 8);
    assert.equal(node.stderr, 'stderr preserved');
    assert.equal(await fs.readFile(path.join(scratch, 'node-output.txt'), 'utf8'), 'Node scratch output');
    assert.equal((await run('printf ignored >/dev/null; printf output')).stdout, 'output');
    await assert.rejects(run('printf captured; printf failure >&2; exit 7'), (error: unknown) => {
      const result = error as { code?: number; stdout?: string; stderr?: string };
      return result.code === 7 && result.stdout === 'captured' && result.stderr === 'failure';
    });

    const abort = new AbortController();
    const pending = run(`exec ${shellQuote(process.execPath)} -e 'setTimeout(() => {}, 30000)'`, abort.signal);
    const timeout = setTimeout(() => abort.abort(), 100);
    try {
      await assert.rejects(pending, (error: unknown) => (error as { name?: string }).name === 'AbortError');
    } finally {
      clearTimeout(timeout);
    }

    // A malicious previous scratch path may not redirect the next command's
    // writable root, including to a different workspace.
    const otherContext = { ...context, sessionId: 'symlink-session' };
    const otherScratch = await ensureAgentRuntimeTempDir(otherContext);
    await fs.rmdir(otherScratch);
    await fs.symlink(workspace, otherScratch);
    await assert.rejects(executeAgentSandboxedCommand('echo must-not-run', {
      context: otherContext, env: { NODE_ENV: 'test' },
    }), /must not contain symbolic links/);
    await assert.rejects(executeAgentSandboxedCommand('echo must-not-run', {
      context: { ...context, workspaceRoot: data }, env: { NODE_ENV: 'test' },
    }), /must be separate from the workspace/);
    assert.equal(await fs.readFile(path.join(workspace, 'original.docx'), 'utf8'), marker);
    console.log(`agent-shell-sandbox-test: ${process.platform} native backend passed; 24 Python/Node workspace mutations denied, scratch ZIP output, abort and Linux seccomp policy verified`);
    if (process.platform === 'linux') {
      console.log(`Linux raw open/openat/openat2 probes passed: ${pythonResult.linuxOpenProbes}; protected file bytes remained intact.`);
    }
    if (process.platform !== 'linux') {
      console.log('Linux Landlock/seccomp backend still requires this test on a real Linux kernel.');
    }
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousCanvasData === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousCanvasData;
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

void main();
