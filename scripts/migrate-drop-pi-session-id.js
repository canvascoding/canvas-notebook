const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DATABASE_URL?.replace('file:', '') || path.join(__dirname, '..', 'data', 'app.db');
const db = new Database(dbPath);

// Check if piSessionId exists
const tableInfo = db.pragma('table_info(studio_generation_outputs)');
const hasColumn = tableInfo.some((col) => col.name === 'pi_session_id');

if (hasColumn) {
  console.log('Dropping pi_session_id from studio_generation_outputs...');
  db.exec(`
    ALTER TABLE studio_generation_outputs DROP COLUMN pi_session_id;
  `);
  console.log('Done.');
} else {
  console.log('pi_session_id does not exist, skipping.');
}

db.close();
