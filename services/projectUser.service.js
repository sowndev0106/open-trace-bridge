const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Per-project OS users: opencode runs as `otb-<slug>` so the kernel, not the
// prompt, stops cross-project reads. Only effective inside the container
// (process runs as root); on a dev host everything is a no-op and opencode
// runs as the current user, same as before.

const AUTH_SRC = process.env.OPENCODE_AUTH_FILE || '/root/.local/share/opencode/auth.json';

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function userName(slug) {
  return `otb-${String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 31);
}

function lookupUser(name) {
  try {
    const ent = execFileSync('getent', ['passwd', name]).toString().trim();
    const parts = ent.split(':');
    return { name, uid: Number(parts[2]), gid: Number(parts[3]), home: parts[5] };
  } catch {
    return null;
  }
}

// Copy the opencode provider auth into the user's home so the CLI can reach
// the model. The agent can read its own copy either way; this leaks nothing
// beyond what the opencode process itself must hold.
function syncOpencodeAuth(user) {
  if (!fs.existsSync(AUTH_SRC)) return;
  const dstDir = path.join(user.home, '.local', 'share', 'opencode');
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, 'auth.json');
  fs.copyFileSync(AUTH_SRC, dst);
  execFileSync('chown', ['-R', `${user.uid}:${user.gid}`, user.home]);
  fs.chmodSync(dst, 0o600);
  fs.chmodSync(user.home, 0o700);
}

function ensureProjectUser(slug) {
  if (!isRoot()) return null;
  const name = userName(slug);
  let user = lookupUser(name);
  if (!user) {
    execFileSync('useradd', ['--system', '--create-home', '--home-dir', `/home/${name}`, '--shell', '/usr/sbin/nologin', name]);
    user = lookupUser(name);
  }
  syncOpencodeAuth(user);
  return user;
}

// Give the workspace to the project user and shut everyone else out.
function ownWorkspace(dir, user) {
  if (!isRoot() || !user) return;
  execFileSync('chown', ['-R', `${user.uid}:${user.gid}`, dir]);
  fs.chmodSync(dir, 0o750);
}

// Root-only shared secrets: the SQLite DB (repo tokens, API keys, messages)
// and the SSH key directory must be invisible to project users.
function secureSharedDirs() {
  if (!isRoot()) return;
  const dbDir = path.dirname(process.env.OTB_DB_PATH || 'data/otb.sqlite');
  const keysDir = path.join(process.env.OTB_WORKSPACES_DIR || 'workspaces', '.keys');
  for (const dir of [dbDir, keysDir]) {
    try { fs.chmodSync(dir, 0o700); } catch { /* missing dir is fine */ }
  }
}

module.exports = { isRoot, userName, ensureProjectUser, ownWorkspace, secureSharedDirs };
