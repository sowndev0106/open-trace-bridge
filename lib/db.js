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
  chat_retention_days INTEGER NOT NULL DEFAULT 90,
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
  description_md TEXT NOT NULL DEFAULT '',
  curl_command TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  opencode_session_id TEXT,
  model TEXT,
  agent TEXT,
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
  conversation_id INTEGER,
  request_params TEXT,
  response_body TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  conversation_id INTEGER,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  cost_usd REAL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discord_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discord_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'mention' CHECK (mode IN ('mention','all')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discord_dm_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  all_projects INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discord_dm_user_projects (
  dm_user_id INTEGER NOT NULL REFERENCES discord_dm_users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (dm_user_id, project_id)
);
CREATE TABLE IF NOT EXISTS discord_dm_selections (
  dm_user_id INTEGER NOT NULL REFERENCES discord_dm_users(id) ON DELETE CASCADE,
  bot_id INTEGER NOT NULL REFERENCES discord_bots(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (dm_user_id, bot_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
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
    "ALTER TABLE projects ADD COLUMN chat_retention_days INTEGER NOT NULL DEFAULT 90",
    "ALTER TABLE repos ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending'",
    "ALTER TABLE repos ADD COLUMN sync_error TEXT",
    "ALTER TABLE repos ADD COLUMN synced_at TEXT",
    "ALTER TABLE api_calls ADD COLUMN conversation_id INTEGER",
    "ALTER TABLE api_calls ADD COLUMN request_params TEXT",
    "ALTER TABLE api_calls ADD COLUMN response_body TEXT",
    "ALTER TABLE api_calls ADD COLUMN error TEXT",
    "ALTER TABLE api_calls ADD COLUMN duration_ms INTEGER",
    "ALTER TABLE api_groups ADD COLUMN curl_command TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE conversations RENAME COLUMN teams_conversation_id TO external_id",
    "ALTER TABLE conversations ADD COLUMN model TEXT",
    "ALTER TABLE conversations ADD COLUMN agent TEXT",
    "ALTER TABLE projects ADD COLUMN discord_bot_id INTEGER REFERENCES discord_bots(id)",
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
