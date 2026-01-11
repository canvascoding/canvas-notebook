import { spawn } from 'node:child_process';

const defaultPorts = [3001, 3002, 3003];
let baseUrl = process.env.BASE_URL;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with code ${code}`));
    });
  });
}

async function waitForServer(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function findAvailablePort() {
  for (const port of defaultPorts) {
    try {
      const response = await fetch(`http://localhost:${port}/login`);
      if (response.ok) {
        continue;
      }
    } catch {
      return port;
    }
  }
  return defaultPorts[defaultPorts.length - 1];
}

async function run() {
  await runCommand('npx', ['next', 'build', '--webpack'], {
    env: { ...process.env, NEXT_DISABLE_TURBOPACK: '1' },
  });

  const port = process.env.PORT || (await findAvailablePort());
  const resolvedBaseUrl = baseUrl || `http://localhost:${port}`;
  baseUrl = resolvedBaseUrl;

  const server = spawn('npm', ['run', 'start'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: port,
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=4096',
      SSH_TEST_MODE: process.env.SSH_TEST_MODE || '1',
      SESSION_SECURE_COOKIES: process.env.SESSION_SECURE_COOKIES || 'false',
      BASE_URL: resolvedBaseUrl,
    },
  });

  const cleanup = () => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(1);
  });

  const ready = await waitForServer();
  if (!ready) {
    cleanup();
    throw new Error('Server did not start in time');
  }

  try {
    await runCommand('npm', ['run', 'test:smoke'], {
      env: { ...process.env, BASE_URL: resolvedBaseUrl },
    });
    await runCommand('npm', ['run', 'test:integration'], {
      env: { ...process.env, BASE_URL: resolvedBaseUrl },
    });
    await runCommand('npm', ['run', 'test:e2e'], {
      env: {
        ...process.env,
        E2E_EXTERNAL_SERVER: '1',
        BASE_URL: resolvedBaseUrl,
      },
    });
  } finally {
    cleanup();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
