import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthBody } from '../src/index.js';

test('health body carries ok, the service name, and the time it was given', () => {
  const body = healthBody('2026-01-01T00:00:00.000Z');
  assert.equal(body.ok, true);
  assert.equal(body.service, '{{SLUG}}');
  assert.equal(body.time, '2026-01-01T00:00:00.000Z');
});
