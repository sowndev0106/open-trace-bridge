const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

process.env.OTB_DB_PATH = ':memory:';

const projectUser = require('../services/projectUser.service');
const opencode = require('../services/opencode.service');

test('userName maps slugs to safe system user names', () => {
  assert.strictEqual(projectUser.userName('payment'), 'otb-payment');
  assert.strictEqual(projectUser.userName('My_Weird Slug!'), 'otb-my-weird-slug-');
  assert.ok(projectUser.userName('a'.repeat(60)).length <= 31);
});

test('everything is a no-op when not running as root (dev host)', () => {
  if (projectUser.isRoot()) return; // only meaningful on a dev host
  assert.strictEqual(projectUser.ensureProjectUser('payment'), null);
  assert.doesNotThrow(() => projectUser.ownWorkspace('/tmp/nope', null));
  assert.doesNotThrow(() => projectUser.secureSharedDirs());
});

function fakeChild(stdoutLine) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    child.stdout.emit('data', stdoutLine);
    child.emit('close', 0);
  });
  return child;
}

test('runPromptStream drops privileges via uid/gid and rebinds HOME when runAs is set', async () => {
  const calls = [];
  const orig = opencode.proc.spawn;
  opencode.proc.spawn = (cmd, args, opts) => {
    calls.push(opts);
    return fakeChild('{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"ok"}}\n');
  };
  try {
    await opencode.runPromptStream({
      dir: '/tmp/ws/payment', text: 'hi',
      runAs: { name: 'otb-payment', uid: 991, gid: 991, home: '/home/otb-payment' },
    });
    assert.strictEqual(calls[0].uid, 991);
    assert.strictEqual(calls[0].gid, 991);
    assert.strictEqual(calls[0].env.HOME, '/home/otb-payment');
    assert.strictEqual(calls[0].env.USER, 'otb-payment');

    await opencode.runPromptStream({ dir: '/tmp/ws/payment', text: 'hi' });
    assert.strictEqual(calls[1].uid, undefined);
    assert.strictEqual(calls[1].gid, undefined);
  } finally {
    opencode.proc.spawn = orig;
  }
});
