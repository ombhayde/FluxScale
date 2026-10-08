import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuCountForQuota, memoryLimitForConstraint } from '../dist/resources.js';

test('CPU normalization respects fractional quota and affinity without inventing a one-core minimum', () => {
  assert.equal(cpuCountForQuota('50000 100000\n', 12), 0.5);
  assert.equal(cpuCountForQuota('200000 100000', 12), 2);
  assert.equal(cpuCountForQuota('200000 100000', 1), 1);
  for (const value of [undefined, '', 'max 100000', '0 100000', '100000 0',
    '-1 100000', 'Infinity 100000', '1e5 100000', '100000 100000 extra', '1 ' + '9'.repeat(400)]) {
    assert.equal(cpuCountForQuota(value, 12), 12);
  }
});

test('Memory normalization uses the smaller OS constraint and preserves host fallback', () => {
  assert.equal(memoryLimitForConstraint(256 * 1024 ** 2, 8 * 1024 ** 3), 256 * 1024 ** 2);
  assert.equal(memoryLimitForConstraint(16 * 1024 ** 3, 8 * 1024 ** 3), 8 * 1024 ** 3);
  for (const value of [0, -1, NaN, Infinity]) {
    assert.equal(memoryLimitForConstraint(value, 8 * 1024 ** 3), 8 * 1024 ** 3);
  }
});
