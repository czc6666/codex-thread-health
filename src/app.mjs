import { formatReceipt, scanJsonlFile, scanJsonlText } from './scanner.mjs';
import { createTelemetry } from './telemetry.mjs';

const telemetry = createTelemetry();
const elements = {
  file: document.querySelector('#fileInput'),
  drop: document.querySelector('#dropZone'),
  choose: document.querySelector('#chooseButton'),
  sample: document.querySelector('#sampleButton'),
  status: document.querySelector('#status'),
  progress: document.querySelector('#progress'),
  result: document.querySelector('#result'),
  risk: document.querySelector('#risk'),
  metrics: document.querySelector('#metrics'),
  findings: document.querySelector('#findings'),
  receipt: document.querySelector('#receipt'),
  copy: document.querySelector('#copyButton'),
  feedback: document.querySelector('#feedbackLink'),
  reset: document.querySelector('#resetButton'),
};

let currentReport = null;
void telemetry.track('page_view');

const LABELS = {
  OVERSIZED_RECORD: 'Oversized record',
  INLINE_BINARY_PAYLOAD: 'Inline binary payload',
  POST_TOOL_CONTINUATION_MISSING: 'No continuation after tool output',
  ORPHANED_ACTIVE_TURN: 'Latest turn has no terminal state',
  LARGE_CONTEXT: 'Large context observed',
  CACHE_COLLAPSE: 'Prompt cache collapse',
  MALFORMED_JSONL: 'Malformed JSONL',
};

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function setStatus(message, tone = 'idle') {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function render(report) {
  currentReport = report;
  elements.result.hidden = false;
  elements.risk.textContent = report.summary.risk.toUpperCase();
  elements.risk.dataset.risk = report.summary.risk;
  elements.metrics.innerHTML = '';
  const rows = [
    ['Records', report.summary.recordCount.toLocaleString('en-US')],
    ['Largest record', formatBytes(report.summary.maxRecordBytes)],
    ['Peak input', report.summary.maxInputTokens ? report.summary.maxInputTokens.toLocaleString('en-US') : 'Not recorded'],
    ['Malformed lines', report.summary.malformedLines.toLocaleString('en-US')],
  ];
  for (const [label, value] of rows) {
    const div = document.createElement('div');
    div.className = 'metric';
    const dt = document.createElement('span');
    dt.textContent = label;
    const dd = document.createElement('strong');
    dd.textContent = value;
    div.append(dt, dd);
    elements.metrics.append(div);
  }

  elements.findings.innerHTML = '';
  if (!report.findings.length) {
    const li = document.createElement('li');
    li.className = 'finding low';
    li.innerHTML = '<div><span class="severity">LOW</span><h3>No structural risk matched</h3></div><p>This does not prove the thread is healthy; it means this receipt found none of its bounded failure signals.</p>';
    elements.findings.append(li);
  }
  for (const item of report.findings) {
    const li = document.createElement('li');
    li.className = `finding ${item.severity}`;
    const head = document.createElement('div');
    const severity = document.createElement('span');
    severity.className = 'severity';
    severity.textContent = item.severity.toUpperCase();
    const title = document.createElement('h3');
    title.textContent = LABELS[item.code] ?? item.code;
    head.append(severity, title);
    const action = document.createElement('p');
    action.textContent = item.action;
    const code = document.createElement('code');
    code.textContent = item.code;
    li.append(head, action, code);
    elements.findings.append(li);
  }
  elements.receipt.value = formatReceipt(report);
  elements.receipt.style.height = 'auto';
  elements.receipt.style.height = `${elements.receipt.scrollHeight + 2}px`;
  setStatus('Scan finished locally. No source text was uploaded or included in the receipt.', 'success');
  elements.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function scanFile(file) {
  if (!file) return;
  void telemetry.track('file_selected');
  elements.result.hidden = true;
  elements.progress.hidden = false;
  elements.progress.value = 0;
  setStatus('Scanning structural metadata locally…', 'working');
  try {
    const report = await scanJsonlFile(file, {
      onProgress: ({ readBytes, totalBytes }) => {
        elements.progress.value = totalBytes ? readBytes / totalBytes : 0;
        setStatus(`Scanning locally — ${formatBytes(readBytes)} / ${formatBytes(totalBytes)}`, 'working');
      },
    });
    render(report);
    void telemetry.track('scan_succeeded');
  } catch (error) {
    console.error(error);
    setStatus('The file could not be scanned. The source stayed local.', 'error');
    void telemetry.track('scan_failed');
  } finally {
    elements.progress.hidden = true;
  }
}

elements.choose.addEventListener('click', () => elements.file.click());
elements.file.addEventListener('change', (event) => scanFile(event.target.files?.[0]));
for (const type of ['dragenter', 'dragover']) {
  elements.drop.addEventListener(type, (event) => {
    event.preventDefault();
    elements.drop.dataset.drag = 'true';
  });
}
for (const type of ['dragleave', 'drop']) {
  elements.drop.addEventListener(type, (event) => {
    event.preventDefault();
    elements.drop.dataset.drag = 'false';
  });
}
elements.drop.addEventListener('drop', (event) => scanFile(event.dataTransfer?.files?.[0]));

elements.sample.addEventListener('click', async () => {
  void telemetry.track('sample_loaded');
  setStatus('Loading a synthetic damaged-thread sample…', 'working');
  const response = await fetch('./sample/sample.jsonl');
  const report = scanJsonlText(await response.text());
  render(report);
});

elements.copy.addEventListener('click', async () => {
  if (!currentReport) return;
  await navigator.clipboard.writeText(formatReceipt(currentReport));
  elements.copy.textContent = 'Copied';
  setTimeout(() => { elements.copy.textContent = 'Copy receipt'; }, 1400);
  void telemetry.track('receipt_copied');
});

elements.feedback.addEventListener('click', () => { void telemetry.track('feedback_clicked'); });
elements.reset.addEventListener('click', () => {
  currentReport = null;
  elements.file.value = '';
  elements.result.hidden = true;
  setStatus('Waiting for a local Codex rollout JSONL.', 'idle');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
