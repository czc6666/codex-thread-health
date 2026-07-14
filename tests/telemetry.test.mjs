import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_EVENTS, createTelemetry, sanitizeEvent } from '../src/telemetry.mjs';

test('only fixed funnel event names are accepted', () => {
  assert.ok(ALLOWED_EVENTS.has('scan_succeeded'));
  assert.throws(() => sanitizeEvent('upload_content'), /not allowlisted/);
});

test('telemetry URL contains only namespace and event name', async () => {
  const calls = [];
  const telemetry = createTelemetry({
    namespace: 'thread-health-test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      throw new Error('offline');
    },
  });

  await telemetry.track('file_selected');

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /thread-health-test\/file_selected\/up$/);
  assert.equal(calls[0].url.includes('filename'), false);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
});
