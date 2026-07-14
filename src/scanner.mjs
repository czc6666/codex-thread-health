const OVERSIZED_RECORD_BYTES = 500_000;
const CRITICAL_INLINE_BINARY_BYTES = 500_000;
const LARGE_CONTEXT_TOKENS = 100_000;
const CACHE_COLLAPSE_RATIO = 0.2;

const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);
const TERMINAL_TYPES = new Set(['task_complete', 'turn_aborted', 'error']);
const CONTINUATION_TYPES = new Set([
  'reasoning',
  'message',
  'agent_message',
  'function_call',
  'custom_tool_call',
  ...TERMINAL_TYPES,
]);
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

function recordType(record) {
  if (record?.payload?.type) return String(record.payload.type);
  return record?.type ? String(record.type) : null;
}

function containsInlineBinary(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'string') {
    return value.startsWith('data:image/') || value.slice(0, 256).includes('base64,');
  }
  if (Array.isArray(value)) return value.some((item) => containsInlineBinary(item, depth + 1));
  if (typeof value === 'object') return Object.values(value).some((item) => containsInlineBinary(item, depth + 1));
  return false;
}

function extractTokenUsage(record) {
  if (record?.payload?.type !== 'token_count') return null;
  const usage = record.payload?.info?.last_token_usage ?? record.payload?.info?.total_token_usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    input: Number(usage.input_tokens ?? 0),
    cached: Number(usage.cached_input_tokens ?? usage.cache_read_tokens ?? 0),
  };
}

function finding(code, severity, evidence, action) {
  return { code, severity, evidence, action };
}

function createState() {
  return {
    records: [],
    malformedLines: 0,
    maxRecordBytes: 0,
    oversizedCount: 0,
    inlineBinaryCount: 0,
    maxInlineBinaryRecordBytes: 0,
    tokenPoints: [],
    skippedOversizedRecords: 0,
    maxBufferedChars: 0,
  };
}

function consumeLine(state, line, byteLength) {
  if (!line.trim()) return;
  state.maxRecordBytes = Math.max(state.maxRecordBytes, byteLength);
  if (byteLength > OVERSIZED_RECORD_BYTES) state.oversizedCount += 1;

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    state.malformedLines += 1;
    return;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    state.malformedLines += 1;
    return;
  }

  state.records.push({ type: recordType(record), bytes: byteLength });
  if (containsInlineBinary(record.payload)) {
    state.inlineBinaryCount += 1;
    state.maxInlineBinaryRecordBytes = Math.max(state.maxInlineBinaryRecordBytes, byteLength);
  }
  const usage = extractTokenUsage(record);
  if (usage) state.tokenPoints.push(usage);
}

function finalize(state) {
  const findings = [];

  if (state.malformedLines) {
    findings.push(finding(
      'MALFORMED_JSONL',
      'high',
      { malformedLines: state.malformedLines },
      'Keep the original unchanged. Back it up before inspecting malformed record boundaries.',
    ));
  }
  if (state.oversizedCount) {
    findings.push(finding(
      'OVERSIZED_RECORD',
      'critical',
      { count: state.oversizedCount, maxRecordBytes: state.maxRecordBytes },
      'Avoid reopening the hot thread. Work from a verified copy and replace oversized content with a reference.',
    ));
  }
  if (state.inlineBinaryCount) {
    const severity = state.maxInlineBinaryRecordBytes >= CRITICAL_INLINE_BINARY_BYTES ? 'critical' : 'medium';
    findings.push(finding(
      'INLINE_BINARY_PAYLOAD',
      severity,
      { count: state.inlineBinaryCount, maxRecordBytes: state.maxInlineBinaryRecordBytes },
      severity === 'critical'
        ? 'Externalize inline binary data in a copied rollout before attempting recovery.'
        : 'Monitor context growth. Small inline media is present but is not proof of a broken thread.',
    ));
  }

  const types = state.records.map((item) => item.type);
  const lastToolOutput = types.reduce((latest, type, index) => TOOL_OUTPUT_TYPES.has(type) ? index : latest, -1);
  if (lastToolOutput >= 0) {
    const after = types.slice(lastToolOutput + 1);
    if (!after.some((type) => CONTINUATION_TYPES.has(type))) {
      findings.push(finding(
        'POST_TOOL_CONTINUATION_MISSING',
        'high',
        { recordsAfterToolOutput: after.length },
        'Interrupt the stale turn and continue from a bounded handoff instead of repeated polling.',
      ));
    }
  }

  const latestStart = types.reduce((latest, type, index) => type === 'task_started' ? index : latest, -1);
  const latestTerminal = types.reduce((latest, type, index) => TERMINAL_TYPES.has(type) ? index : latest, -1);
  if (latestStart > latestTerminal) {
    findings.push(finding(
      'ORPHANED_ACTIVE_TURN',
      'high',
      { terminalAfterLatestStart: false },
      'Treat the latest turn as interrupted; avoid repeatedly resuming the same hot state.',
    ));
  }

  const maxInputTokens = state.tokenPoints.reduce((value, point) => Math.max(value, point.input), 0);
  if (maxInputTokens >= LARGE_CONTEXT_TOKENS) {
    findings.push(finding(
      'LARGE_CONTEXT',
      'medium',
      { maxInputTokens },
      'Create a bounded handoff or fork before continuing this long thread.',
    ));
  }
  for (let index = 1; index < state.tokenPoints.length; index += 1) {
    const previous = state.tokenPoints[index - 1];
    const current = state.tokenPoints[index];
    if (previous.cached >= 50_000 && current.cached <= previous.cached * CACHE_COLLAPSE_RATIO) {
      findings.push(finding(
        'CACHE_COLLAPSE',
        'medium',
        { previousCachedTokens: previous.cached, currentCachedTokens: current.cached },
        'This may indicate expensive context reconstruction. Treat it as a signal, not a proven root cause.',
      ));
      break;
    }
  }

  const risk = findings.reduce(
    (highest, item) => SEVERITY_RANK[item.severity] > SEVERITY_RANK[highest] ? item.severity : highest,
    'low',
  );

  return {
    schema: 'codex-thread-health/v1',
    privacy: {
      contentIncluded: false,
      pathsIncluded: false,
      filenamesIncluded: false,
      commandBodiesIncluded: false,
    },
    summary: {
      risk,
      recordCount: state.records.length,
      malformedLines: state.malformedLines,
      maxRecordBytes: state.maxRecordBytes,
      maxInputTokens,
      skippedOversizedRecords: state.skippedOversizedRecords,
      maxBufferedChars: state.maxBufferedChars,
    },
    findings,
  };
}

export function scanJsonlText(text) {
  const state = createState();
  for (const line of text.split(/\r?\n/)) {
    consumeLine(state, line, new TextEncoder().encode(line).byteLength);
  }
  return finalize(state);
}

export async function scanJsonlFile(file, { onProgress = () => {} } = {}) {
  const state = createState();
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let readBytes = 0;
  let oversizedLineBytes = 0;
  let skippingOversizedLine = false;

  function consumeTextSegment(segment) {
    let cursor = 0;
    while (cursor < segment.length) {
      const newline = segment.indexOf('\n', cursor);
      const piece = newline >= 0 ? segment.slice(cursor, newline) : segment.slice(cursor);
      const pieceBytes = new TextEncoder().encode(piece).byteLength;

      if (skippingOversizedLine) {
        oversizedLineBytes += pieceBytes;
        if (newline >= 0) {
          state.skippedOversizedRecords += 1;
          state.oversizedCount += 1;
          state.maxRecordBytes = Math.max(state.maxRecordBytes, oversizedLineBytes);
          skippingOversizedLine = false;
          oversizedLineBytes = 0;
        }
      } else {
        const pendingBytes = new TextEncoder().encode(pending).byteLength;
        const projectedBytes = pendingBytes + pieceBytes;
        if (projectedBytes > OVERSIZED_RECORD_BYTES) {
          const prefix = (pending + piece.slice(0, Math.max(0, 4096 - pending.length))).slice(0, 4096);
          const inlineBinary = prefix.startsWith('data:image/') || prefix.includes('base64,');
          oversizedLineBytes = projectedBytes;
          pending = '';
          if (inlineBinary) {
            state.inlineBinaryCount += 1;
            state.maxInlineBinaryRecordBytes = Math.max(state.maxInlineBinaryRecordBytes, projectedBytes);
          }
          if (newline >= 0) {
            state.skippedOversizedRecords += 1;
            state.oversizedCount += 1;
            state.maxRecordBytes = Math.max(state.maxRecordBytes, oversizedLineBytes);
            oversizedLineBytes = 0;
          } else {
            skippingOversizedLine = true;
          }
        } else {
          pending += piece;
          state.maxBufferedChars = Math.max(state.maxBufferedChars, pending.length);
          if (newline >= 0) {
            consumeLine(state, pending.replace(/\r$/, ''), new TextEncoder().encode(pending).byteLength);
            pending = '';
          }
        }
      }
      if (newline < 0) break;
      cursor = newline + 1;
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    readBytes += value.byteLength;
    consumeTextSegment(decoder.decode(value, { stream: true }));
    onProgress({ readBytes, totalBytes: file.size });
  }
  consumeTextSegment(decoder.decode());
  if (skippingOversizedLine) {
    state.skippedOversizedRecords += 1;
    state.oversizedCount += 1;
    state.maxRecordBytes = Math.max(state.maxRecordBytes, oversizedLineBytes);
  } else if (pending) {
    consumeLine(state, pending, new TextEncoder().encode(pending).byteLength);
  }
  return finalize(state);
}

export function formatReceipt(report) {
  const lines = [
    'Codex Thread Health Receipt',
    `Risk: ${report.summary.risk.toUpperCase()}`,
    `Records scanned: ${report.summary.recordCount}`,
    `Largest record: ${report.summary.maxRecordBytes.toLocaleString('en-US')} bytes`,
    `Peak input tokens observed: ${report.summary.maxInputTokens.toLocaleString('en-US')}`,
    '',
    'Findings:',
  ];
  if (!report.findings.length) lines.push('- No structural risk signal matched.');
  for (const item of report.findings) lines.push(`- [${item.severity}] ${item.code}: ${item.action}`);
  lines.push('', 'Privacy: generated locally; no filename, path, prompt, command, tool output, or conversation text included.');
  lines.push('This is a heuristic health report, not an official OpenAI diagnosis or automatic repair.');
  return lines.join('\n');
}
