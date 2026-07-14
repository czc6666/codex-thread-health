# Codex Thread Health

A browser-local, read-only structural health receipt for Codex rollout JSONL files.

**Live:** https://czc6666.github.io/codex-thread-health/

## Narrow promise

Before reopening or repeatedly resuming a problematic Codex thread, scan its rollout locally for bounded structural signals:

- oversized records;
- inline binary/image payloads;
- a successful tool output with no later continuation;
- a latest turn with no terminal event;
- large observed input context;
- abrupt prompt-cache collapse;
- malformed JSONL.

The browser streams the file line by line. It does not upload the rollout and the generated receipt excludes filenames, paths, prompts, commands, tool outputs, model names, and conversation text.

## What it does not do

- It does not modify, truncate, restore, or reindex Codex state.
- It does not diagnose OpenAI backend latency or prove a root cause.
- Its thresholds are evidence-derived heuristics, not official Codex guarantees.
- A successful scan is not evidence that the product is useful; only an affected external user's changed recovery decision counts.

## Development

```bash
npm test
npm run check
python3 -m http.server 4174
```

Then open `http://127.0.0.1:4174`.

## Privacy-preserving observability

The public page sends only fixed anonymous counter names:

```text
page_view
sample_loaded
file_selected
scan_succeeded
scan_failed
receipt_copied
feedback_clicked
```

No dynamic metadata is attached. Telemetry failure never blocks the local scan.

---

# Spike evidence


Given a Codex rollout JSONL, can a local scanner identify the public failure families behind oversized records, inline image payloads, missing post-tool continuation, orphaned latest turns, large context, cache collapse, and malformed JSONL—without returning prompts, paths, commands, or tool output?

## Method

- Browser streaming uses a bounded line buffer and O(1) aggregate state; oversized lines are counted without retaining their bodies.
- Structural metadata only: record type, byte length, timestamp, and token counters.
- Public issue-derived fixtures:
  - openai/codex#33008: 885 KB single-message freeze.
  - openai/codex#33021: 2.4–2.9M-character inline image event.
  - openai/codex#33024: 115K–132K input with cache collapse and missing continuation.
- Negative fixture: a completed turn containing a normal 100 KB tool output.
- Real-format check: 14 local Codex rollout files, 5.8 MB total, without exporting filenames or content.

## Result

```text
12 passed
```

Public-derived fixtures:

| Fixture | Expected signal | Result |
|---|---|---|
| 885 KB single message | oversized record | detected |
| 2.9M inline image | oversized + inline binary + stalled latest turn | detected |
| 132K input / cache collapse | large context + cache collapse + missing continuation | detected |
| completed 100 KB output | low risk | low risk |

Real local corpus after false-positive correction:

- 14/14 parsed successfully.
- 11 low risk.
- 2 medium risk from context/cache indicators.
- 1 medium risk from context/cache plus a small inline image.
- No high/critical false alarm after changing orphan detection from cumulative counts to latest-turn state.

## Privacy boundary

The report contains no:

- conversation text;
- prompt;
- command body;
- tool output;
- filename;
- full path;
- repository name;
- credential.

Only categorical findings and numeric structural counters are emitted.

## Verdict: PARTIAL

### What worked

- Publicly described failure boundaries are detectable from local JSONL structure.
- The scanner distinguishes a normal 100 KB result from a pathological 885 KB–2.9 MB event.
- Real Codex rollout shapes parse successfully.
- A false-positive latest-turn rule was found and corrected through a failing test.

### What is not validated

- No affected external user has run this scanner.
- No user has said the receipt changes their recovery decision.
- No one has provided a sanitized structural report or offered to pay.
- Thresholds are evidence-derived heuristics, not official Codex guarantees.

### Recommendation

Build only a static, browser-local Thread Health Receipt:

- no repair/write operation;
- no upload;
- no login/backend;
- no general Codex dashboard;
- fixed anonymous funnel events only;
- one feedback issue asking whether the finding changed the user's next action.

Then invite exactly one highly matched affected user after explicit approval to post on a third-party issue.
