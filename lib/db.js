const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  keyword TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  teams_webhook_url TEXT NOT NULL DEFAULT '',
  max_msg_length INTEGER NOT NULL DEFAULT 20000,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  git_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'none',
  token TEXT,
  ssh_key TEXT,
  branch TEXT NOT NULL DEFAULT 'main',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS api_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  auth_header TEXT NOT NULL DEFAULT 'Authorization',
  allowed_methods TEXT NOT NULL DEFAULT 'GET',
  description_md TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  teams_conversation_id TEXT NOT NULL,
  opencode_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let db = null;

function getDb() {
  if (db) return db;
  const dbPath = process.env.OTB_DB_PATH || 'data/otb.sqlite';
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Migrations for databases created before these columns existed.
  const migrations = [
    "ALTER TABLE projects ADD COLUMN max_msg_length INTEGER NOT NULL DEFAULT 20000",
    "ALTER TABLE repos ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending'",
    "ALTER TABLE repos ADD COLUMN sync_error TEXT",
    "ALTER TABLE repos ADD COLUMN synced_at TEXT",
  ];
  for (const stmt of migrations) {
    try { db.exec(stmt); } catch { /* already exists */ }
  }
  return db;
}

function resetDbForTest() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, resetDbForTest };
