'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkAndHeal, buildHealPrompt } = require('../src/self-heal');

test('self-heal is disabled by default without touching the database', async () => {
  const previous = process.env.HEIMDALL_SELF_HEAL_ENABLED;
  delete process.env.HEIMDALL_SELF_HEAL_ENABLED;
  try {
    const result = await checkAndHeal({
      prepare() { throw new Error('database must not be read while disabled'); },
    });
    assert.deepEqual(result, { enabled: false, tasksSubmitted: 0 });
  } finally {
    if (previous === undefined) delete process.env.HEIMDALL_SELF_HEAL_ENABLED;
    else process.env.HEIMDALL_SELF_HEAL_ENABLED = previous;
  }
});

test('self-heal prompt uses configured storage identity', () => {
  const previousHost = process.env.HEIMDALL_STORAGE_SSH_HOST;
  const previousUser = process.env.HEIMDALL_STORAGE_SSH_USER;
  process.env.HEIMDALL_STORAGE_SSH_HOST = 'storage.example.test';
  process.env.HEIMDALL_STORAGE_SSH_USER = 'monitor';
  try {
    const prompt = buildHealPrompt('mimir');
    assert.match(prompt, /ssh monitor@storage\.example\.test/);
    assert.doesNotMatch(prompt, /Magnus|100\./);
  } finally {
    if (previousHost === undefined) delete process.env.HEIMDALL_STORAGE_SSH_HOST;
    else process.env.HEIMDALL_STORAGE_SSH_HOST = previousHost;
    if (previousUser === undefined) delete process.env.HEIMDALL_STORAGE_SSH_USER;
    else process.env.HEIMDALL_STORAGE_SSH_USER = previousUser;
  }
});
