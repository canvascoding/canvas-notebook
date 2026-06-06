const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { hashPassword } = require('better-auth/crypto');
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
    process.stdin.on('end', () => {
      resolve(value.replace(/\r?\n$/, ''));
    });
    process.stdin.on('error', reject);
  });
}

function printCliUsage() {
  console.log(`Usage:
  node scripts/bootstrap-admin.js
  node scripts/bootstrap-admin.js --email <email> [--name <name>] --password-stdin

Without CLI options, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are read from the environment.`);
}

async function getBootstrapAdminConfigFromArgs(args) {
  let email = null;
  let name = 'Administrator';
  let passwordStdin = false;
  let hasCliOptions = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--email') {
      hasCliOptions = true;
      index += 1;
      if (index >= args.length) {
        throw new Error('--email requires a value.');
      }
      email = args[index];
      continue;
    }

    if (arg.startsWith('--email=')) {
      hasCliOptions = true;
      email = arg.slice('--email='.length);
      continue;
    }

    if (arg === '--name') {
      hasCliOptions = true;
      index += 1;
      if (index >= args.length) {
        throw new Error('--name requires a value.');
      }
      name = args[index];
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

    if (arg === '-h' || arg === '--help') {
      printCliUsage();
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!hasCliOptions) {
    return null;
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('--email is required when using CLI bootstrap options.');
  }

  if (!passwordStdin) {
    throw new Error('--password-stdin is required when using CLI bootstrap options.');
  }

  const password = await readStdin();
  if (!password) {
    throw new Error('Password stdin was empty.');
  }

  return {
    email: normalizedEmail,
    password,
    name: name.trim() || 'Administrator',
  };
}

async function getBootstrapAdminConfig() {
  const cliConfig = await getBootstrapAdminConfigFromArgs(process.argv.slice(2));
  if (cliConfig) {
    return cliConfig;
  }

  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator').trim() || 'Administrator';

  if (!email || !password) {
    return null;
  }

  return { email, password, name };
}

function getSqlitePath() {
  const dataDir = process.env.DATA || path.resolve(process.cwd(), 'data');
  return path.join(dataDir, 'sqlite.db');
}

function ensureBootstrapTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL,
  image TEXT,
  role TEXT,
  banned INTEGER,
  ban_reason TEXT,
  ban_expires INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_unique ON user (email);
`);

  for (const [column, definition] of [
    ['banned', 'INTEGER'],
    ['ban_reason', 'TEXT'],
    ['ban_expires', 'INTEGER'],
  ]) {
    const exists = db.prepare('PRAGMA table_info(user)').all().some((row) => row.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE user ADD COLUMN ${column} ${definition}`);
    }
  }
}

function openDatabase() {
  const sqlitePath = getSqlitePath();
  const db = new Database(sqlitePath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  ensureBootstrapTables(db);
  return { db, sqlitePath };
}

function findUserByEmail(db, email) {
  return db.prepare('SELECT id, email, role, name FROM user WHERE lower(email) = ? LIMIT 1').get(email) || null;
}

function findBootstrapTargetUser(db) {
  return db.prepare(`
    SELECT id, email, role, name
    FROM user
    ORDER BY
      CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
      created_at ASC
    LIMIT 1
  `).get() || null;
}

function ensureCredentialPassword(db, userId, passwordHash) {
  const existingAccount = db
    .prepare('SELECT id FROM account WHERE user_id = ? AND provider_id = ? LIMIT 1')
    .get(userId, 'credential');

  const now = Date.now();

  if (existingAccount) {
    db.prepare(`
      UPDATE account
      SET account_id = ?, password = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, passwordHash, now, existingAccount.id);
    return;
  }

  db.prepare(`
    INSERT INTO account (
      id, account_id, provider_id, user_id, password, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, 'credential', userId, passwordHash, now, now);
}

function updateExistingUser(db, userId, email, name) {
  db.prepare(`
    UPDATE user
    SET name = ?, email = ?, role = ?, updated_at = ?
    WHERE id = ?
  `).run(name, email, 'admin', Date.now(), userId);
}

function insertUser(db, email, name) {
  const userId = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, image, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, name, email, 1, null, 'admin', now, now);

  return userId;
}

async function main() {
  const bootstrapAdmin = await getBootstrapAdminConfig();

  if (!bootstrapAdmin) {
    console.log('[bootstrap-admin] Skipped (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set).');
    return;
  }

  const { db, sqlitePath } = openDatabase();
  console.log(`[bootstrap-admin] Using SQLite database: ${sqlitePath}`);

  try {
    const { email, password, name } = bootstrapAdmin;
    const passwordHash = await hashPassword(password);
    db.exec('BEGIN IMMEDIATE');

    const existingUser = findUserByEmail(db, email);
    if (existingUser) {
      updateExistingUser(db, existingUser.id, email, name);
      ensureCredentialPassword(db, existingUser.id, passwordHash);
      db.exec('COMMIT');

      const verifiedUser = findUserByEmail(db, email);
      if (!verifiedUser) {
        throw new Error(`Bootstrap admin missing after sync: ${email}`);
      }

      console.log(`[bootstrap-admin] Synced bootstrap admin user: ${email}`);
      return;
    }

    const targetUser = findBootstrapTargetUser(db);
    if (targetUser) {
      updateExistingUser(db, targetUser.id, email, name);
      ensureCredentialPassword(db, targetUser.id, passwordHash);
      db.exec('COMMIT');

      const verifiedUser = findUserByEmail(db, email);
      if (!verifiedUser) {
        throw new Error(`Bootstrap admin missing after override: ${email}`);
      }

      console.log(`[bootstrap-admin] Updated existing admin credentials: ${targetUser.email} -> ${email}`);
      return;
    }

    const userId = insertUser(db, email, name);
    ensureCredentialPassword(db, userId, passwordHash);
    db.exec('COMMIT');

    const verifiedUser = findUserByEmail(db, email);
    if (!verifiedUser) {
      throw new Error(`Bootstrap admin missing after creation: ${email}`);
    }

    console.log(`[bootstrap-admin] Created admin user: ${email}`);
  } catch (error) {
    if (db.inTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('[bootstrap-admin] Failed:', error);
  process.exit(1);
});
