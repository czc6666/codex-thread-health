import test from 'node:test';
import assert from 'node:assert/strict';
import { scanJsonlFile, scanJsonlText } from '../src/scanner.mjs';

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function codes(report) {
  return new Set(report.findings.map((finding) => finding.code));
}

test('completed healthy turn stays low risk', () => {
  const report = scanJsonlText(jsonl([
    { timestamp: '2026-07-14T10:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-14T10:00:01Z', type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } },
    { timestamp: '2026-07-14T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    { timestamp: '2026-07-14T10:00:03Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ]));

  assert.equal(report.summary.risk, 'low');
  assert.equal(report.findings.length, 0);
});

test('885KB single message is critical and report excludes source content', () => {
  const privateMarker = 'PRIVATE_INPUT_SHOULD_NOT_APPEAR';
  const report = scanJsonlText(jsonl([
    { timestamp: '2026-07-14T10:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-14T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: privateMarker + 'X'.repeat(885_000) } },
  ]));

  assert.ok(codes(report).has('OVERSIZED_RECORD'));
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
});

test('large inline image is critical and stalled tool boundary is identified', () => {
  const report = scanJsonlText(jsonl([
    { timestamp: '2026-07-14T10:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-14T10:00:01Z', type: 'response_item', payload: { type: 'function_call_output', output: 'data:image/png;base64,' + 'A'.repeat(600_000) } },
  ]));

  assert.ok(codes(report).has('OVERSIZED_RECORD'));
  assert.ok(codes(report).has('INLINE_BINARY_PAYLOAD'));
  assert.ok(codes(report).has('POST_TOOL_CONTINUATION_MISSING'));
  assert.ok(codes(report).has('ORPHANED_ACTIVE_TURN'));
  assert.equal(report.summary.risk, 'critical');
});

test('small inline media is medium, not critical', () => {
  const report = scanJsonlText(jsonl([
    { timestamp: '2026-07-14T10:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-14T10:00:01Z', type: 'response_item', payload: { type: 'function_call_output', output: 'data:image/png;base64,' + 'A'.repeat(100_000) } },
    { timestamp: '2026-07-14T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    { timestamp: '2026-07-14T10:00:03Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ]));

  const inline = report.findings.find((finding) => finding.code === 'INLINE_BINARY_PAYLOAD');
  assert.equal(inline.severity, 'medium');
  assert.equal(report.summary.risk, 'medium');
});

test('latest completed turn is authoritative over old imbalance', () => {
  const report = scanJsonlText(jsonl([
    { timestamp: '2026-07-14T09:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-14T10:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-14T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    { timestamp: '2026-07-14T10:00:02Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ]));

  assert.equal(codes(report).has('ORPHANED_ACTIVE_TURN'), false);
});

test('large context and cache collapse use counters only', () => {
  const report = scanJsonlText(jsonl([
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 114_907, cached_input_tokens: 110_336 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 132_000, cached_input_tokens: 9_984 } } } },
  ]));

  assert.ok(codes(report).has('LARGE_CONTEXT'));
  assert.ok(codes(report).has('CACHE_COLLAPSE'));
});

test('streaming scan caps buffered content for a multi-megabyte single record', async () => {
  const encoder = new TextEncoder();
  const prefix = '{"type":"response_item","payload":{"type":"message","content":"';
  const suffix = '"}}\n';
  const chunks = [
    encoder.encode(prefix + 'A'.repeat(400_000)),
    encoder.encode('B'.repeat(400_000)),
    encoder.encode('C'.repeat(400_000) + suffix),
  ];
  const file = {
    size: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    stream() {
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    },
  };

  const report = await scanJsonlFile(file);

  assert.ok(codes(report).has('OVERSIZED_RECORD'));
  assert.equal(report.summary.skippedOversizedRecords, 1);
  assert.equal(report.summary.maxBufferedChars <= 500_000, true);
  assert.equal(report.summary.malformedLines, 0);
});

test('malformed JSONL is reported without aborting scan', () => {
  const report = scanJsonlText('{"type":"event_msg","payload":{"type":"task_started"}}\nnot-json\n');

  assert.ok(codes(report).has('MALFORMED_JSONL'));
  assert.equal(report.summary.malformedLines, 1);
});
