import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const defaultPorts = [3000, 3001, 3002];
let baseUrl = process.env.BASE_URL;

function resolveTestCredentials() {
  const testEmail = process.env.TEST_LOGIN_EMAIL;
  const testPassword = process.env.TEST_LOGIN_PASSWORD;
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if ((testEmail && !testPassword) || (!testEmail && testPassword)) {
    throw new Error('Set TEST_LOGIN_EMAIL and TEST_LOGIN_PASSWORD together');
  }

  if ((bootstrapEmail && !bootstrapPassword) || (!bootstrapEmail && bootstrapPassword)) {
    throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD together');
  }

  if (testEmail && testPassword) {
    return { email: testEmail, password: testPassword };
  }

  if (bootstrapEmail && bootstrapPassword) {
    return { email: bootstrapEmail, password: bootstrapPassword };
  }

  const suffix = randomBytes(6).toString('hex');
  return {
    email: `test-admin-${suffix}@local.test`,
    password: `T3st!${randomBytes(12).toString('base64url')}`,
  };
}

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
  await runCommand('npx', ['next', 'build']);

  const port = process.env.PORT || (await findAvailablePort());
  const resolvedBaseUrl = baseUrl || `http://localhost:${port}`;
  const credentials = resolveTestCredentials();
  baseUrl = resolvedBaseUrl;

  const server = spawn('npm', ['run', 'start'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: port,
      BASE_URL: resolvedBaseUrl,
      BETTER_AUTH_BASE_URL: process.env.BETTER_AUTH_BASE_URL || resolvedBaseUrl,
      BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL || credentials.email,
      BOOTSTRAP_ADMIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD || credentials.password,
      BOOTSTRAP_ADMIN_NAME: process.env.BOOTSTRAP_ADMIN_NAME || 'Test Admin',
      TEST_LOGIN_EMAIL: credentials.email,
      TEST_LOGIN_PASSWORD: credentials.password,
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
      env: {
        ...process.env,
        BASE_URL: resolvedBaseUrl,
        TEST_LOGIN_EMAIL: credentials.email,
        TEST_LOGIN_PASSWORD: credentials.password,
      },
    });
    await runCommand('npm', ['run', 'test:integration'], {
      env: {
        ...process.env,
        BASE_URL: resolvedBaseUrl,
        TEST_LOGIN_EMAIL: credentials.email,
        TEST_LOGIN_PASSWORD: credentials.password,
      },
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
