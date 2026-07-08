const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const settings = require('../models/setting.model');

const CACHE_TTL_MS = 10 * 60 * 1000;

// Indirection over execFile so tests can stub CLI calls.
const proc = { execFile: promisify(execFile) };

let modelCache = null; // { at, values }
function _resetCache() { modelCache = null; }

async function listModels(dir) {
  if (modelCache && Date.now() - modelCache.at < CACHE_TTL_MS) return modelCache.values;
  const { stdout } = await proc.execFile('opencode', ['models'], { cwd: dir, timeout: 30000 });
  const values = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  modelCache = { at: Date.now(), values };
  return values;
}

async function allowedModels(dir) {
  const all = await listModels(dir);
  const raw = settings.get('discord_allowed_models');
  const allow = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!allow.length) return all;
  return all.filter((m) => allow.includes(m));
}

function defaultModel() {
  const v = settings.get('discord_default_model');
  return v && v.trim() ? v.trim() : null;
}

async function listAgents(dir) {
  const { stdout } = await proc.execFile('opencode', ['agent', 'list'], { cwd: dir, timeout: 30000 });
  return String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
}

function frontmatterField(md, field) {
  const m = String(md).match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

function scanSkillDir(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const md = fs.readFileSync(f, 'utf8');
    out.push({ name: frontmatterField(md, 'name') || e.name, description: frontmatterField(md, 'description') });
  }
  return out;
}

function listSkills(ws) {
  return [
    ...scanSkillDir(path.join(ws, '.opencode', 'skill')),
    ...scanSkillDir(path.join(os.homedir(), '.config', 'opencode', 'skill')),
  ];
}

function listCommands(ws) {
  const dir = path.join(ws, '.opencode', 'command');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.filter((f) => f.endsWith('.md')).map((f) => {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    const desc = frontmatterField(md, 'description')
      || md.split('\n').find((l) => l.trim() && !l.startsWith('---')) || '';
    return { name: f.replace(/\.md$/, ''), description: desc.trim() };
  });
}

module.exports = { proc, _resetCache, listModels, allowedModels, defaultModel, listAgents, listSkills, listCommands };
