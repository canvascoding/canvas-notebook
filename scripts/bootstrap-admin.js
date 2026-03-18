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

function getBootstrapAdminConfig() {
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
}

function openDatabase() {
  const sqlitePath = getSqlitePath();
  const db = new Database(sqlitePath);
  db.pragma('foreign_keys = ON');
  ensureBootstrapTables(db);
  return { db, sqlitePath };
}

function findUserByEmail(db, email) {
  return db.prepare('SELECT id, email, role, name FROM user WHERE lower(email) = ? LIMIT 1').get(email) || null;
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
  const bootstrapAdmin = getBootstrapAdminConfig();

  if (!bootstrapAdmin) {
    console.log('[bootstrap-admin] Skipped (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set).');
    return;
  }

  const { db, sqlitePath } = openDatabase();
  console.log(`[bootstrap-admin] Using SQLite database: ${sqlitePath}`);

  try {
    const { email, password, name } = bootstrapAdmin;
    const passwordHash = await hashPassword(password);
    const existingUser = findUserByEmail(db, email);

    if (existingUser) {
      updateExistingUser(db, existingUser.id, email, name);
      ensureCredentialPassword(db, existingUser.id, passwordHash);

      const verifiedUser = findUserByEmail(db, email);
      if (!verifiedUser) {
        throw new Error(`Bootstrap admin missing after sync: ${email}`);
      }

      console.log(`[bootstrap-admin] Synced bootstrap admin user: ${email}`);
      return;
    }

    const userId = insertUser(db, email, name);
    ensureCredentialPassword(db, userId, passwordHash);

    const verifiedUser = findUserByEmail(db, email);
    if (!verifiedUser) {
      throw new Error(`Bootstrap admin missing after creation: ${email}`);
    }

    console.log(`[bootstrap-admin] Created admin user: ${email}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('[bootstrap-admin] Failed:', error);
  process.exit(1);
});
