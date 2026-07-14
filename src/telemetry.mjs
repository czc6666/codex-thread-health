export const ALLOWED_EVENTS = new Set([
  'page_view',
  'sample_loaded',
  'file_selected',
  'scan_succeeded',
  'scan_failed',
  'receipt_copied',
  'feedback_clicked',
]);

export function sanitizeEvent(name) {
  if (!ALLOWED_EVENTS.has(name)) throw new Error(`Telemetry event is not allowlisted: ${name}`);
  return { name };
}

export function createTelemetry({
  namespace = 'codex-thread-health-prod-v1',
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  async function track(name) {
    const event = sanitizeEvent(name);
    if (!fetchImpl) return event;
    const url = `https://api.counterapi.dev/v1/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/up`;
    try {
      await fetchImpl(url, {
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      // Anonymous telemetry must never block local analysis.
    }
    return event;
  }
  return { track };
}
