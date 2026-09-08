import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [dockerfile, source, runtime] = await Promise.all([
  readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
  readFile(new URL('../tools/agent-sandbox/landlock-run.c', import.meta.url), 'utf8'),
  readFile(new URL('../app/lib/pi/agent-bash-runtime.ts', import.meta.url), 'utf8'),
]);

assert.match(dockerfile, /COPY tools\/agent-sandbox\/landlock-run\.c/);
assert.match(dockerfile, /-Wall -Wextra -Werror -std=c11/);
assert.match(
  dockerfile,
  /COPY tools\/agent-sandbox\/landlock-run\.c[\s\S]*?\/opt\/canvas-agent-landlock[\s\S]*?FROM canvas-base AS app-base/,
);
assert.match(dockerfile, /COPY --from=libvips-build \/opt\/canvas-agent-landlock \/usr\/local\/libexec\/canvas-agent-landlock/);
assert.match(dockerfile, /^USER \$\{APP_USER\}$/m);
assert.doesNotMatch(dockerfile, /CAP_SYS_ADMIN|seccomp=unconfined|--privileged/);

assert.match(source, /CANVAS_LANDLOCK_MIN_ABI 3/);
assert.match(source, /LANDLOCK_ACCESS_FS_TRUNCATE/);
assert.match(source, /LANDLOCK_ACCESS_FS_REFER/);
assert.match(source, /PR_SET_NO_NEW_PRIVS/);
assert.match(source, /landlock_restrict_self/);
assert.match(source, /O_PATH \| O_CLOEXEC/);
assert.match(source, /close_inherited_descriptors/);

assert.match(runtime, /CANVAS_RUNTIME_ENV === 'docker'/);
assert.match(runtime, /'landlock'/);
assert.match(runtime, /executeAgentSandboxedProcess\(\{ executable: launcherPath, args \}/);
assert.match(runtime, /executeAgentSandboxedProcess\(\{ executable: '\/bin\/bash'/);
assert.doesNotMatch(runtime, /execFileAsync/);
assert.doesNotMatch(runtime, /filterSafeEnv/);

console.log('agent-bash-sandbox-source-test: ok');
