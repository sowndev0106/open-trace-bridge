const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.OTB_DB_PATH = ':memory:';
const { resetDbForTest } = require('../lib/db');
const settings = require('../models/setting.model');
const info = require('../services/opencodeInfo.service');

beforeEach(() => { resetDbForTest(); info._resetCache(); });

test('allowedModels intersects CLI output with the admin allowlist', async () => {
  info.proc.execFile = async () => ({ stdout: 'anthropic/claude-sonnet-5\nanthropic/claude-opus-4-8\nopenai/gpt-5\n' });
  settings.set('discord_allowed_models', 'anthropic/claude-sonnet-5\nopenai/gpt-5');
  const models = await info.allowedModels('/tmp/ws');
  assert.deepStrictEqual(models, ['anthropic/claude-sonnet-5', 'openai/gpt-5']);
});

test('allowedModels returns all CLI models when no allowlist is set', async () => {
  info.proc.execFile = async () => ({ stdout: 'a/m1\nb/m2\n' });
  assert.deepStrictEqual(await info.allowedModels('/tmp/ws'), ['a/m1', 'b/m2']);
});

test('listModels caches CLI output', async () => {
  let calls = 0;
  info.proc.execFile = async () => { calls += 1; return { stdout: 'a/m1\n' }; };
  await info.listModels('/tmp/ws');
  await info.listModels('/tmp/ws');
  assert.strictEqual(calls, 1);
});

test('listSkills and listCommands scan the workspace', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-info-'));
  fs.mkdirSync(path.join(ws, '.opencode', 'skill', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.opencode', 'skill', 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy helper\n---\nBody');
  fs.mkdirSync(path.join(ws, '.opencode', 'command'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.opencode', 'command', 'health.md'), 'Check service health');
  const skills = info.listSkills(ws);
  assert.deepStrictEqual(skills.find((s) => s.name === 'deploy'), { name: 'deploy', description: 'Deploy helper' });
  assert.deepStrictEqual(info.listCommands(ws), [{ name: 'health', description: 'Check service health' }]);
});

test('listAgents parses CLI lines', async () => {
  info.proc.execFile = async () => ({ stdout: 'build\nplan\n' });
  assert.deepStrictEqual(await info.listAgents('/tmp/ws'), ['build', 'plan']);
});

test('listCommands description fallback skips frontmatter when description field is absent', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-info-'));
  fs.mkdirSync(path.join(ws, '.opencode', 'command'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.opencode', 'command', 'health.md'),
    '---\nname: health\n---\nCheck service health');
  assert.deepStrictEqual(info.listCommands(ws), [{ name: 'health', description: 'Check service health' }]);
});

test('listSkills only reads description from the frontmatter block, not the body', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'otb-info-'));
  fs.mkdirSync(path.join(ws, '.opencode', 'skill', 'real'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.opencode', 'skill', 'real', 'SKILL.md'),
    '---\nname: real\ndescription: Real desc\n---\nBody text\ndescription: fake');
  fs.mkdirSync(path.join(ws, '.opencode', 'skill', 'nofield'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.opencode', 'skill', 'nofield', 'SKILL.md'),
    '---\nname: nofield\n---\nBody text\ndescription: fake');
  const skills = info.listSkills(ws);
  assert.deepStrictEqual(skills.find((s) => s.name === 'real'), { name: 'real', description: 'Real desc' });
  assert.deepStrictEqual(skills.find((s) => s.name === 'nofield'), { name: 'nofield', description: '' });
});
