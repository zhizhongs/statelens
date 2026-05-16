# Pipeline Phase 2 Implementation Design

Owner: Person A - Pipeline Engineer
References: [`../DESIGN.md`](../DESIGN.md), [`./ROLE_PIPELINE.md`](./ROLE_PIPELINE.md), [`./PIPELINE_PHASE1_IMPLEMENTATION.md`](./PIPELINE_PHASE1_IMPLEMENTATION.md)
Phase: 2, hours 6-14

## Objective

Phase 2 turns the Phase 1 structured-diff pipeline into the intelligent pipeline:

```text
current screenshot Buffer
  -> session previous screenshot lookup
  -> Stage 1 visual gate
  -> Stage 2 changed-region localization
  -> Stage 3 OCR text diff on changed crops
  -> Stage 4 importance scoring
  -> Stage 5 selective VLM explanation when local signals are insufficient
  -> Stage 6 timeline assembly with honest VLM usage accounting
  -> ObservationResult
```

The deliverable is a complete pipeline library that decides whether a frame is a keyframe, summarizes explainable text changes locally, calls Haiku only for selected high-value frames, and exposes cumulative VLM token usage for Person B's measurement harness.

## Scope

In scope:

- `src/pipeline/importanceScorer.ts`
- `src/pipeline/vlmExplainer.ts`
- `src/pipeline/timeline.ts`
- `src/pipeline/index.ts`, replacing the Phase 1 provisional orchestrator with the full Stage 1-6 orchestrator
- `src/utils/image.ts`, only for existing image metadata helpers needed by the orchestrator or VLM media type detection
- `tests/pipeline/*.test.ts`

Out of scope:

- MCP server and CLI changes in `src/server.ts` and `src/index.ts`
- Demo scripts, eval harness, README, screenshots, and pricing tables
- New package dependencies without coordinating with Person B
- Broad error-hardening for corrupted images and long-running memory pressure, which is Phase 3 work

## Starting Point After Phase 1

Phase 1 already provides:

- Working Stage 1, Stage 2, and Stage 3 implementations.
- A minimal `observe()` that returns `session_start`, `no_change`, `text_changed`, and `ui_changed`.
- `SessionTimeline` with previous screenshot storage, total screenshot count, event storage, and VLM call count.
- Stubbed VLM usage exports in `src/pipeline/index.ts` that always return zero.

Phase 2 replaces or completes:

- `importanceScore()` in `src/pipeline/importanceScorer.ts`.
- `vlmExplain()` in `src/pipeline/vlmExplainer.ts`.
- `getVlmCumulativeUsage()` and `resetVlmCumulativeUsage()` in `src/pipeline/index.ts` so they proxy the real Stage 5 counter.
- The Phase 1 hardcoded importance scores and provisional event typing in `observe()`.

## Locked Integration Contract

Do not change these exports or type names in `src/pipeline/index.ts`:

```ts
export async function observe(
  screenshotBuffer: Buffer,
  sessionId?: string,
  actionLabel?: string
): Promise<ObservationResult>;

export function getTimeline(sessionId: string): TimelineResult;
export function resetSession(sessionId: string): void;

export function getVlmCumulativeUsage(): { input_tokens: number; output_tokens: number };
export function resetVlmCumulativeUsage(): void;
```

Do not rename `ObservationResult`, `TimelineResult`, `TimelineEvent`, `ChangedRegion`, `TextDiff`, or `VlmUsage`. Person B's MCP server and measurement harness consume these names.

## Phase 2 Behavior

The Phase 2 orchestrator keeps Phase 1's session semantics, but replaces the provisional event decision with scoring and selective VLM.

| Condition | `changed` | `keyframe` | `event_type` | Add to timeline | `vlm_called` |
|---|---:|---:|---|---:|---:|
| First screenshot in session | true | true | `session_start` | yes | false |
| Stage 1 filters frame | false | false | `no_change` | no | false |
| Stage 4 score `< 0.3` | true | false | `minor_change` | no | false |
| Text diff is sufficient | true | true | inferred from text | yes | false |
| VLM explanation is needed | true | true | from `vlmExplain()` | yes | true |
| Fallback keyframe, no VLM | true | true | `ui_change` | yes | false |

Timeline policy:

- `session_start` remains a timeline event.
- `no_change` and `minor_change` do not become timeline events.
- Every keyframe event records `text_diff`, `regions`, and `vlm_used`.
- `total_screenshots` increments for every `observe()` call, including filtered frames.
- `vlm_calls_made` increments only when a timeline event has `vlm_used: true`.

## Stage 4 - `importanceScorer.ts`

Purpose: decide whether a visual/text diff is important, whether text alone explains it, and whether the orchestrator should call the VLM.

Implementation:

```ts
export interface ScoreResult {
  score: number;
  textSufficient: boolean;
  shouldCallVlm: boolean;
}

export function importanceScore(
  regions: ChangedRegion[],
  textDiff: TextDiff,
  imgW: number,
  imgH: number
): ScoreResult
```

Scoring rules from `DESIGN.md` Section 4.5:

- Start `score = 0`.
- If `textDiff.added.length > 0`, add `0.4`.
- If added text contains an error keyword, add `0.2`.
- If total changed region area is greater than 10 percent of the screen, add `0.3`.
- If any changed region has label `center modal`, add `0.1`.
- `textSufficient = textDiff.added.length > 0 && score < 0.7`.
- `shouldCallVlm = score > 0.5 && !textSufficient`.

Error keywords:

```ts
['error', 'invalid', 'failed', 'denied', 'warning', 'required']
```

Implementation details:

- Keep this function pure and synchronous.
- Treat `imgW <= 0` or `imgH <= 0` as no screen area contribution instead of dividing by zero.
- The current maximum score is `1.0`, so no score clamp is required.
- Preserve the exact camelCase `ScoreResult` field names. The public `ObservationResult` still uses snake_case.

Known spec edge:

- With the literal Section 4.5 formula, visual-only changes max out at `0.4` (`large region` + `center modal`), so they will not satisfy `score > 0.5`. Implement the spec first. During the Phase 2 checkpoint, verify whether the demo gets the expected 2-3 VLM calls. If visual-only frames never trigger VLM, tune the threshold only after coordinating with Person B and updating tests.

## Stage 5 - `vlmExplainer.ts`

Purpose: generate a semantic event only for keyframes where local text/region signals are insufficient.

Existing interface:

```ts
export interface VlmExplanation {
  eventType: string;
  summary: string;
  importantText: string[];
}

export async function vlmExplain(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  regions: ChangedRegion[]
): Promise<VlmExplanation>;

export function getCumulativeUsage(): VlmUsage;
export function resetCumulativeUsage(): void;
```

Model:

```ts
const MODEL = 'claude-haiku-4-5-20251001';
```

Implementation decisions:

- Use `@anthropic-ai/sdk`.
- Create the Anthropic client lazily so importing the pipeline in tests does not require `ANTHROPIC_API_KEY`.
- Use `max_tokens: 200`.
- Send both screenshots as base64 image blocks plus one text prompt.
- Detect media type with `sharp(buffer).metadata().format` when possible:
  - `jpeg` or `jpg` -> `image/jpeg`
  - otherwise -> `image/png`
- Return a normalized camelCase `VlmExplanation`, even though the model prompt asks for JSON keys like `event_type` and `important_text`.
- Strip optional Markdown fences before `JSON.parse()`.
- If the response has no text block or malformed JSON, throw a clear error in Phase 2. Phase 3 can convert this into a structured fallback observation.

Prompt:

```text
You are analyzing two consecutive UI screenshots.
Describe only the meaningful UI state change in one sentence.
Changed region: <regions JSON>

Focus on: error messages, modals, button state changes, form changes, navigation, content loading, layout shifts.

Return JSON only:
{
  "event_type": "short_snake_case",
  "summary": "one concise sentence",
  "important_text": ["key visible text"]
}
```

Usage accounting is non-negotiable:

```ts
const response = await client.messages.create(...);

cumulativeUsage.input_tokens += response.usage.input_tokens ?? 0;
cumulativeUsage.output_tokens += response.usage.output_tokens ?? 0;
```

Add usage immediately after every API response returns, before parsing the model JSON. If parsing fails, the token counter must still reflect the API call that happened.

Do not count Sonnet tokens here. Stage 5 only tracks Haiku tokens internal to StateLens. Person B's measurement harness adds these to the StateLens run totals through `getVlmCumulativeUsage()`.

## Stage 6 - `timeline.ts`

The Phase 1 `SessionTimeline` is mostly complete. Phase 2 should verify it matches the final semantics:

- `getPrevScreenshot()` and `setPrevScreenshot()` store the per-session prior frame.
- `incrementTotal()` runs once per `observe()` call.
- `addEvent()` appends only keyframe events and increments `vlmCalls` when `event.vlm_used` is true.
- `getTimeline()` returns:
  - `session_id`
  - `total_screenshots`
  - `keyframes: events.length`
  - `vlm_calls_made`
  - `vlm_calls_saved: totalScreenshots - vlmCalls`
  - `reduction_pct`
  - `estimated_tokens_saved`
  - `events`

Keep the event object shape snake_case because `TimelineEvent` is exported through `src/pipeline/index.ts`.

Do not add required timeline fields in Phase 2. If `actionLabel` needs to appear later, make it optional and coordinate with Person B first.

## Full Orchestrator - `index.ts`

Replace the Phase 1 provisional decision block in `observe()` with the full Stage 1-6 flow.

Required imports:

```ts
import { importanceScore } from './importanceScorer.js';
import { vlmExplain, getCumulativeUsage, resetCumulativeUsage } from './vlmExplainer.js';
import { getImageDimensions } from '../utils/image.js';
```

Flow:

1. Start a latency timer.
2. Get or create the `SessionTimeline`.
3. `session.incrementTotal()`.
4. Read `prev = session.getPrevScreenshot()`.
5. Store the current screenshot with `session.setPrevScreenshot(screenshotBuffer)`.
6. If there is no previous screenshot, return and record `session_start`.
7. Run `visualGate(prev, screenshotBuffer)`.
8. If unchanged, return `no_change` without adding a timeline event.
9. Run `spatialDiff(prev, screenshotBuffer)`.
10. Run `ocrDiff(prev, screenshotBuffer, regions)` only when `regions.length > 0`.
11. Read current image dimensions with `getImageDimensions(screenshotBuffer)`.
12. Run `importanceScore(regions, textDiff, width, height)`.
13. If `score < 0.3`, return `minor_change` without adding a timeline event.
14. If `textSufficient`, infer an event type and build a text-based summary locally.
15. Else if `shouldCallVlm`, call `vlmExplain(prev, screenshotBuffer, regions)`.
16. Else build a generic region-based `ui_change` summary.
17. Add the keyframe event to the session timeline.
18. Return `ObservationResult` with all fields populated.

Suggested helper behavior:

```ts
function inferEventType(textDiff: TextDiff): string {
  const added = textDiff.added.join(' ').toLowerCase();
  if (/(error|invalid|failed|denied|required)/.test(added)) return 'error_appeared';
  if (added.includes('warning')) return 'warning_appeared';
  if (textDiff.added.length && textDiff.removed.length) return 'text_changed';
  if (textDiff.added.length) return 'text_appeared';
  if (textDiff.removed.length) return 'text_removed';
  return 'ui_change';
}
```

Summary rules:

- Prefer OCR text when available.
- Include at most the first 2-3 text lines so CLI and MCP output stay readable.
- If no text exists, summarize unique region labels: `UI changed in top banner, content area`.
- For VLM output, trust `vlmExplain().summary` and `vlmExplain().eventType`.

VLM usage exports:

```ts
export function getVlmCumulativeUsage(): VlmUsage {
  return getCumulativeUsage();
}

export function resetVlmCumulativeUsage(): void {
  resetCumulativeUsage();
}
```

`resetSession(sessionId)` should still delete only that session. It should not reset global VLM usage; Person B's measurement harness calls `resetVlmCumulativeUsage()` separately so accounting stays explicit.

## Test Design

Keep tests deterministic. Unit tests must not make real Anthropic calls.

### `importanceScorer.test.ts`

Cases:

- Empty regions and empty text returns `score: 0`, `textSufficient: false`, `shouldCallVlm: false`.
- Added non-error text adds `0.4` and is text-sufficient.
- Added error text adds `0.6` and is still text-sufficient because it is below `0.7`.
- Added error text plus a large region produces a score above `0.7`, is not text-sufficient, and sets `shouldCallVlm: true`.
- A large center modal with no text receives the region and modal boosts.

### `vlmExplainer.test.ts`

Mock `@anthropic-ai/sdk`.

Cases:

- Parses JSON with snake_case model keys into camelCase `VlmExplanation`.
- Strips ```json fences when present.
- Increments cumulative usage after a successful call.
- `resetCumulativeUsage()` clears both counters.
- Usage is still counted when the API returns malformed JSON and parsing throws.
- Missing text content throws a clear error.

### `timeline.test.ts`

Cases:

- `incrementTotal()` affects `total_screenshots`.
- `addEvent()` appends events.
- A `vlm_used: true` event increments `vlm_calls_made`.
- `reduction_pct` is stable for zero screenshots and non-zero screenshots.

### `index.test.ts`

Update the existing orchestrator tests:

- First frame still returns and records `session_start`.
- Identical second frame still returns `no_change` and does not add a timeline event.
- Low-score visual change returns `minor_change`, `keyframe: false`, and does not add a timeline event.
- Text-sufficient change returns a keyframe with `vlm_called: false`.
- High-score, not-text-sufficient change calls mocked `vlmExplain()` and returns `vlm_called: true`.
- `getVlmCumulativeUsage()` and `resetVlmCumulativeUsage()` proxy the Stage 5 counter.
- `resetSession()` clears screenshot history but does not clear VLM usage.

## Performance Targets

| Stage | Target | Notes |
|---|---:|---|
| Stage 4 importance scorer | `<1ms` | Pure arithmetic and string matching. |
| Stage 5 VLM explainer | rare, expected `1-3s` | Network/API call; only selected keyframes. |
| Stage 6 timeline assembly | `<1ms` | In-memory append and counters. |
| Phase 2 no-change `observe()` | close to Stage 1 cost | Must still skip Stages 2-5. |
| Phase 2 text-sufficient `observe()` | local pipeline only | Must skip Stage 5. |

The key Phase 2 performance win is selectivity, not making VLM calls faster.

## Failure Handling

Phase 2 should keep failures explicit:

- If Stage 5 needs an API key and none is configured, throw a clear `ANTHROPIC_API_KEY is required for vlmExplain()` error.
- If Anthropic returns malformed JSON, throw a clear parse error after counting usage.
- If Stage 4 receives invalid image dimensions, skip the area contribution instead of crashing.
- Preserve Phase 1 behavior for image decode, crop, and OCR errors.

Phase 3 will convert more of these cases into never-throw user-facing observations.

## Implementation Order

1. Run `npm run build` and `npm test` against the completed Phase 1 code.
2. Implement `importanceScore()` and `tests/pipeline/importanceScorer.test.ts`.
3. Implement `vlmExplain()`, usage accounting, and `tests/pipeline/vlmExplainer.test.ts`.
4. Add focused timeline tests and adjust `SessionTimeline` only if needed.
5. Replace the Phase 1 `observe()` decision logic with the full Stage 1-6 orchestrator.
6. Wire `getVlmCumulativeUsage()` and `resetVlmCumulativeUsage()` to Stage 5.
7. Update `tests/pipeline/index.test.ts` for scoring, VLM, and timeline behavior.
8. Run `npm run build`.
9. Run `npm test`.
10. With Person B's harness and `ANTHROPIC_API_KEY` configured, run:

```bash
npm run measure
```

## Phase 2 Merge Checkpoint

At hour 14, stop and verify together:

1. `git pull origin main`.
2. `npm run build` passes.
3. `npm test` passes.
4. `npm run measure` produces non-stub numbers.
5. Haiku usage appears in the StateLens run totals through `getVlmCumulativeUsage()`.
6. `resetVlmCumulativeUsage()` is called between measurement runs and clears the counter.
7. `eval/results/phase2_baseline.json` is saved by Person B.
8. If savings are below 30 percent or VLM calls are unexpectedly zero, debug thresholds and usage resets before moving to Phase 3.

## Definition of Done

Phase 2 is done when:

- Stage 4, Stage 5, and Stage 6 have focused tests.
- `observe()` uses Stages 1-6 end to end.
- Text-sufficient keyframes do not call VLM.
- Selected high-importance keyframes call `vlmExplain()`.
- `getVlmCumulativeUsage()` reflects every Haiku call.
- `resetVlmCumulativeUsage()` clears the Haiku counter.
- `getTimeline()` reports real keyframes and VLM call counts.
- `npm run build` passes.
- `npm test` passes.
- The locked pipeline exports remain unchanged.
- No files owned by Person B were modified.
