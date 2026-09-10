const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadAppEnv } = require('../server/load-app-env.js');

loadAppEnv(process.cwd());

function normalizeEmail(email) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return normalized || null;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      value += chunk;
    });
    process.stdin.on('end', () => resolve(value.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

function printCliUsage() {
  console.log(`Usage:
  node scripts/bootstrap-admin.js
  node scripts/bootstrap-admin.js --ensure
  node scripts/bootstrap-admin.js --email <email> [--name <name>] --password-stdin

Without CLI options, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are read from the environment.
--ensure creates the first admin when needed without overwriting an existing user's login details.`);
}

async function getBootstrapAdminConfigFromArgs(args) {
  let email = null;
  let name = 'Administrator';
  let passwordStdin = false;
  let hasCliOptions = false;
  let ensureOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--email' || arg === '--name') {
      hasCliOptions = true;
      index += 1;
      if (index >= args.length) throw new Error(`${arg} requires a value.`);
      if (arg === '--email') email = args[index];
      else name = args[index];
      continue;
    }
    if (arg.startsWith('--email=')) {
      hasCliOptions = true;
      email = arg.slice('--email='.length);
      continue;
    }
    if (arg.startsWith('--name=')) {
      hasCliOptions = true;
      name = arg.slice('--name='.length);
      continue;
    }
    if (arg === '--password-stdin') {
      hasCliOptions = true;
      passwordStdin = true;
      continue;
    }
    if (arg === '--ensure') {
      hasCliOptions = true;
      ensureOnly = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printCliUsage();
      return { helpOnly: true };
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!hasCliOptions) return null;
  if (ensureOnly) {
    if (args.length !== 1) throw new Error('--ensure cannot be combined with other CLI bootstrap options.');
    return { ensureOnly: true };
  }
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('--email is required when using CLI bootstrap options.');
  if (!passwordStdin) throw new Error('--password-stdin is required when using CLI bootstrap options.');
  const password = await readStdin();
  if (!password) throw new Error('Password stdin was empty.');
  return { email: normalizedEmail, password, name: name.trim() || 'Administrator', ensureOnly: false };
}

async function getBootstrapAdminConfig() {
  const cliConfig = await getBootstrapAdminConfigFromArgs(process.argv.slice(2));
  if (cliConfig?.helpOnly) return cliConfig;
  if (cliConfig?.ensureOnly) {
    const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator').trim() || 'Administrator';
    if (!email || !password) return null;
    return { email, password, name, ensureOnly: true };
  }
  if (cliConfig) return cliConfig;
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator').trim() || 'Administrator';
  if (!email || !password) return null;
  return { email, password, name, ensureOnly: false };
}

function runPostgresBootstrapAdmin(config) {
  const tsxCli = path.join(path.dirname(require.resolve('tsx')), 'cli.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCli, '--conditions', 'react-server', 'scripts/bootstrap-admin-postgres.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOOTSTRAP_ADMIN_EMAIL: config.email,
        BOOTSTRAP_ADMIN_PASSWORD: config.password,
        BOOTSTRAP_ADMIN_NAME: config.name,
        BOOTSTRAP_ADMIN_ENSURE_ONLY: config.ensureOnly ? 'true' : '',
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

async function main() {
  const config = await getBootstrapAdminConfig();
  if (config?.helpOnly) return;
  if (!config) {
    console.log('[bootstrap-admin] Skipped (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set).');
    return;
  }
  runPostgresBootstrapAdmin(config);
}

main().catch((error) => {
  console.error('[bootstrap-admin] Failed:', error);
  process.exit(1);
});
