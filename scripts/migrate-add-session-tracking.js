#!/usr/bin/env node

/**
 * Migration: Adds lastMessageAt and lastViewedAt columns to pi_sessions table
 * 
 * This script adds two new timestamp columns for tracking unread AI responses:
 * - lastMessageAt: When the last AI response was completed
 * - lastViewedAt: When the user last viewed the session
 * 
 * hasUnread is derived: lastMessageAt > lastViewedAt
 * 
 * Note: If the database doesn't exist yet, the schema will include these columns
 * automatically on first app start. This script is only needed for existing databases.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'canvas.db');

console.log('[Migration] Adding session tracking columns to pi_sessions...');
console.log(`[Migration] Database: ${DB_PATH}`);

// Check if database exists
if (!fs.existsSync(DB_PATH)) {
  console.log('[Migration] Database does not exist yet. Columns will be created on first app start.');
  console.log('[Migration] ✓ Nothing to do - exiting gracefully');
  process.exit(0);
}

try {
  // Check if columns already exist
  const checkResult = execSync(
    `sqlite3 "${DB_PATH}" "PRAGMA table_info(pi_sessions);"`,
    { encoding: 'utf-8' }
  );
  
  const hasLastMessageAt = checkResult.includes('last_message_at');
  const hasLastViewedAt = checkResult.includes('last_viewed_at');
  
  if (hasLastMessageAt && hasLastViewedAt) {
    console.log('[Migration] Columns already exist. Skipping.');
    process.exit(0);
  }
  
  // Add lastMessageAt column
  if (!hasLastMessageAt) {
    console.log('[Migration] Adding last_message_at column...');
    execSync(
      `sqlite3 "${DB_PATH}" "ALTER TABLE pi_sessions ADD COLUMN last_message_at INTEGER;"`,
      { encoding: 'utf-8' }
    );
    console.log('[Migration] ✓ last_message_at added');
  }
  
  // Add lastViewedAt column
  if (!hasLastViewedAt) {
    console.log('[Migration] Adding last_viewed_at column...');
    execSync(
      `sqlite3 "${DB_PATH}" "ALTER TABLE pi_sessions ADD COLUMN last_viewed_at INTEGER;"`,
      { encoding: 'utf-8' }
    );
    console.log('[Migration] ✓ last_viewed_at added');
  }
  
  // Create index for performance (hasUnread filtering)
  console.log('[Migration] Creating index on last_message_at...');
  try {
    execSync(
      `sqlite3 "${DB_PATH}" "CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_message ON pi_sessions(last_message_at);"`,
      { encoding: 'utf-8' }
    );
    console.log('[Migration] ✓ Index created');
  } catch (indexErr) {
    console.warn('[Migration] Warning: Could not create index:', indexErr.message);
  }
  
  // Initialize existing sessions: set lastMessageAt to max message timestamp for sessions with messages
  console.log('[Migration] Initializing last_message_at for existing sessions...');
  execSync(
    `sqlite3 "${DB_PATH}" "UPDATE pi_sessions SET last_message_at = (SELECT MAX(timestamp) FROM pi_messages WHERE pi_session_db_id = pi_sessions.id) WHERE last_message_at IS NULL;"`,
    { encoding: 'utf-8' }
  );
  console.log('[Migration] ✓ Existing sessions initialized');
  
  // Set lastViewedAt = lastMessageAt (or createdAt if no messages) for all existing sessions
  // This marks all existing sessions as "read" so they don't show unread indicators
  console.log('[Migration] Initializing last_viewed_at for existing sessions...');
  execSync(
    `sqlite3 "${DB_PATH}" "UPDATE pi_sessions SET last_viewed_at = COALESCE(last_message_at, createdAt) WHERE last_viewed_at IS NULL;"`,
    { encoding: 'utf-8' }
  );
  console.log('[Migration] ✓ Existing sessions marked as read');
  
  console.log('[Migration] ✓ Migration completed successfully!');
  
} catch (error) {
  if (error.message.includes('no such table: pi_sessions')) {
    console.log('[Migration] pi_sessions table does not exist yet. Will be created on first app start.');
    console.log('[Migration] ✓ Nothing to do - exiting gracefully');
    process.exit(0);
  }
  console.error('[Migration] Error:', error.message);
  if (error.stdout) console.error(error.stdout);
  if (error.stderr) console.error(error.stderr);
  process.exit(1);
}
