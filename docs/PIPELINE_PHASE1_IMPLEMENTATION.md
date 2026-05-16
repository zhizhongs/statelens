# Pipeline Phase 1 Implementation Design

Owner: Person A - Pipeline Engineer  
References: [`../DESIGN.md`](../DESIGN.md), [`./ROLE_PIPELINE.md`](./ROLE_PIPELINE.md)  
Phase: 1, hours 0-6

## Objective

Phase 1 turns the pipeline stubs into a working local image-diff library:

```text
current screenshot Buffer
  -> session previous screenshot lookup
  -> Stage 1 visual gate
  -> Stage 2 changed-region localization
  -> Stage 3 OCR text diff on changed crops
  -> ObservationResult
```

The deliverable is not the final intelligent pipeline. It is the foundation that lets Person B's CLI and MCP server receive real structured diffs without any VLM calls.

## Scope

In scope:

- `src/pipeline/visualGate.ts`
- `src/pipeline/spatialDiff.ts`
- `src/pipeline/ocrDiff.ts`
- `src/pipeline/index.ts`, only enough to wire Stages 1-3 into the locked `observe()` contract
- `src/utils/image.ts`
- `tests/pipeline/*.test.ts`

Out of scope:

- MCP server and CLI changes in `src/server.ts` and `src/index.ts`
- Demo scripts, eval harness, README, and screenshots
- Stage 4 importance scoring
- Stage 5 VLM explanation and Anthropic usage accounting
- New dependencies without coordinating with Person B

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

Phase 1 may add private helpers, but Person B should continue to see only the locked interface.

## Phase 1 Behavior

Because `observe()` is the only surface Person B consumes, Phase 1 needs a minimal orchestrator even though the full Stage 4-6 orchestrator is scheduled for Phase 2.

Phase 1 `observe()` behavior:

1. Get or create the session.
2. Increment `totalScreenshots`.
3. Read the previous screenshot from the session.
4. Store the current screenshot as the new previous screenshot.
5. If there is no previous screenshot, return `session_start`.
6. Run `visualGate(prev, curr)`.
7. If the gate says unchanged, return `no_change`.
8. Run `spatialDiff(prev, curr)`.
9. Run `ocrDiff(prev, curr, regions)` only when `regions.length > 0`.
10. Build a provisional text or region summary.
11. Add keyframe events to the session timeline.
12. Return `ObservationResult` with `vlm_called: false`.

Provisional event types:

| Condition | `event_type` | `keyframe` | `importance_score` |
|---|---|---:|---:|
| First screenshot | `session_start` | true | 1.0 |
| Stage 1 filters frame | `no_change` | false | 0 |
| OCR finds added or removed text | `text_changed` | true | 0.6 |
| Regions changed with no text diff | `ui_changed` | true | 0.4 |

These scores are placeholders. Phase 2 replaces them with `importanceScore()`.

## Stage 1 - `visualGate.ts`

Purpose: filter redundant or near-identical screenshots before OCR.

Implementation decisions:

- Decode both buffers with `sharp`.
- Resize both images to `640 x 360`.
- Force a consistent 4-channel raw layout with `ensureAlpha().raw()`.
- MD5 hash the normalized buffers before pixel comparison.
- If hashes match, return:

```ts
{ changed: false, gate: 'hash_exact', distance: 0 }
```

- Otherwise run `pixelmatch(prev, curr, diff, 640, 360, { threshold: 0.1 })`.
- Compute `diffPercent = diffPixels / (640 * 360)`.
- If `diffPercent < diffThreshold` where `diffThreshold` defaults to `0.02`, return:

```ts
{ changed: false, gate: 'pixelmatch', diffPixels, diffPercent }
```

- Otherwise return:

```ts
{ changed: true, gate: 'passed', diffPixels, diffPercent }
```

Notes:

- Keep `GateResult` as-is.
- The Stage 2 diff-image reuse optimization can be implemented later through a private helper, but Phase 1 should not change the exported `GateResult` shape to carry a diff image.
- Stage 1 operates on normalized comparison images. Stage 2 still returns coordinates in the current screenshot's coordinate space.

## Stage 2 - `spatialDiff.ts`

Purpose: convert pixel differences into labeled UI regions.

Implementation decisions:

- Use the current screenshot dimensions as canonical output coordinates.
- Decode both images to raw RGBA at the canonical dimensions:

```ts
const { width, height } = await sharp(currBuffer).metadata();
const prev = await sharp(prevBuffer).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
const curr = await sharp(currBuffer).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
```

- Run `pixelmatch` with threshold `0.1`.
- Scan the pixelmatch diff buffer for changed pixels. Treat a pixel as changed when it is red-dominant, for example:

```ts
red > 200 && green < 80 && blue < 80 && alpha > 0
```

- Use connected component analysis with 4-neighbor flood fill.
- Track:
  - visited pixels in a `Uint8Array`
  - component pixel count
  - `minX`, `minY`, `maxX`, `maxY`
- Drop components whose changed-pixel count is below `minArea`, default `500`.
- Convert each surviving component to:

```ts
{ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
```

- Label each region with the existing `classifyRegion()` helper.
- Sort output deterministically by `y`, then `x`.

Expected labels:

| Region shape/location | Label |
|---|---|
| Large centered overlay | `center modal` |
| Top 15 percent | `top banner` |
| Bottom 15 percent | `bottom bar` |
| Left 25 percent | `left sidebar` |
| Right 25 percent | `right panel` |
| Anything else | `content area` |

Edge behavior:

- No changed pixels returns `[]`.
- Full-screen changes return one large region.
- Mismatched screenshot dimensions are normalized to current screenshot dimensions instead of throwing.

## Stage 3 - `ocrDiff.ts`

Purpose: extract text that appeared or disappeared inside changed regions.

Implementation decisions:

- Use a module-level singleton Tesseract worker.
- Lazy-init the worker only on the first non-empty `regions` call.
- If `regions.length === 0`, return `{ added: [], removed: [] }` without initializing Tesseract.
- OCR crops only. Do not OCR the whole screenshot as a fallback.
- For each region:
  - Clamp crop bounds to the current screenshot dimensions.
  - Extract the same crop rectangle from both previous and current screenshots with `sharp.extract()`.
  - OCR both crops.
  - Split OCR text on newlines.
  - Trim each line.
  - Collapse repeated whitespace.
  - Drop empty lines.
  - Add cleaned lines to a Set.
- Return set differences:

```ts
{
  added: [...currTexts].filter((t) => !prevTexts.has(t)),
  removed: [...prevTexts].filter((t) => !currTexts.has(t))
}
```

Important nuance:

- If Stage 2 returns a full-screen region, OCRing that crop is allowed because it is still driven by region selection. The forbidden path is bypassing Stage 2 and OCRing every full screenshot unconditionally.

## `src/utils/image.ts`

Implement `getImageDimensions()` with `sharp(buffer).metadata()`.

Behavior:

- Return `{ width, height }` as numbers.
- Throw a clear error if either dimension is missing.
- Do not silently return zero dimensions.

This helper is used by Stage 2 crop clamping and by the Phase 2 orchestrator.

## Minimal Phase 1 Orchestrator

The Phase 1 orchestrator should live in `src/pipeline/index.ts` and remain intentionally simple.

Session state:

```ts
const sessions = new Map<string, SessionTimeline>();
```

Use the existing `SessionTimeline` class for:

- previous screenshot storage
- screenshot counts
- basic event log
- timeline response formatting

Do not call Stage 4 or Stage 5 in Phase 1.

Summary builder:

```ts
function buildPhase1Summary(textDiff: TextDiff, regions: ChangedRegion[]): string {
  if (textDiff.added.length && textDiff.removed.length) {
    return `Text changed: added "${firstAdded}", removed "${firstRemoved}"`;
  }
  if (textDiff.added.length) {
    return `Text appeared: "${firstAdded}"`;
  }
  if (textDiff.removed.length) {
    return `Text disappeared: "${firstRemoved}"`;
  }
  if (regions.length) {
    return `UI changed in ${uniqueLabels.join(', ')}`;
  }
  return 'Visual change detected';
}
```

Limit summaries to the first few text lines or region labels so CLI output stays readable.

Timeline policy:

- Add `session_start`, `text_changed`, and `ui_changed` to the timeline.
- Do not add `no_change` frames to `events`.
- `vlm_used` is always false in Phase 1.
- `getTimeline()` for an unknown session returns the same empty shape as the current stub.
- `resetSession()` deletes only that session.

VLM usage policy:

- `getVlmCumulativeUsage()` returns `{ input_tokens: 0, output_tokens: 0 }`.
- `resetVlmCumulativeUsage()` is a no-op in Phase 1.
- The real counter is Stage 5 work in Phase 2.

## Test Design

Create deterministic image fixtures in tests with `sharp`, not checked-in binary files.

Recommended helpers:

```ts
async function solidPng(width: number, height: number, color: string): Promise<Buffer>
async function pngWithSvg(width: number, height: number, svg: string): Promise<Buffer>
```

### `visualGate.test.ts`

Cases:

- Identical buffers return `changed: false`, `gate: 'hash_exact'`, `distance: 0`.
- Tiny diff below 2 percent returns `changed: false`, `gate: 'pixelmatch'`.
- Large diff above 2 percent returns `changed: true`, `gate: 'passed'`.

### `spatialDiff.test.ts`

Cases:

- No change returns `[]`.
- One changed rectangle returns one region with expected bounds and label.
- Two separated rectangles return two sorted regions.
- Full-screen color change returns one large region.

Use smaller `minArea` values in tests when the synthetic fixture is intentionally tiny.

### `ocrDiff.test.ts`

Unit tests should mock `tesseract.js` for determinism and speed:

- Text added returns that line in `added`.
- Text removed returns that line in `removed`.
- Same recognized text returns empty arrays.
- Empty regions return empty arrays and do not create a worker.

Run a manual or optional integration check with real Tesseract for latency, but do not make the main unit suite depend on OCR language data downloads.

### `index.test.ts`

Cases:

- First frame returns `session_start`.
- Identical second frame returns `no_change`.
- Changed second frame returns regions and text diff with `vlm_called: false`.
- `resetSession()` clears previous screenshot and timeline.

Mocks are acceptable here if direct OCR makes the test slow or flaky.

## Performance Targets

| Stage | Target | Notes |
|---|---:|---|
| Stage 1 visual gate | `<5ms` identical-buffer hot path | Hash after resize dominates. |
| Stage 2 spatial diff | `<10ms` typical screenshot pair | Flood fill should use typed arrays. |
| Stage 3 OCR diff | `<200ms` pre-warmed 400x60 crop | First Tesseract call can be about 2s. |
| Phase 1 no-change `observe()` | close to Stage 1 cost | Should skip Stage 2 and Stage 3. |

Do not optimize by changing public types during Phase 1. If performance is close but not perfect, prioritize correctness and the merge checkpoint.

## Failure Handling

Phase 1 should fail loudly in unit tests, but user-facing `observe()` should return useful structured output where reasonable.

Preferred behavior:

- Invalid or unsupported image buffer: throw from the stage function; let tests catch the bug.
- Empty OCR regions: return empty text diff.
- Crop outside image bounds: clamp before `sharp.extract()`.
- Tesseract recognition failure on a region: skip that region and continue only if the error is region-local. If worker initialization fails, surface the error.

Phase 3 will harden these into never-throw user-facing observations.

## Implementation Order

1. Run `npm run build` against the stubs and fix existing TypeScript errors only if needed.
2. Implement `src/utils/image.ts`.
3. Implement Stage 1 and `visualGate.test.ts`.
4. Implement Stage 2 and `spatialDiff.test.ts`.
5. Implement Stage 3 and `ocrDiff.test.ts`.
6. Implement the minimal Phase 1 `observe()`, `getTimeline()`, and `resetSession()` wiring.
7. Add `index.test.ts`.
8. Run `npm run build`.
9. Run `npm test`.
10. Run the Phase 1 merge checkpoint command once Person B has demo screenshots:

```bash
node dist/demo/run.js demo/screenshots/login_flow
```

## Definition of Done

Phase 1 is done when:

- `npm run build` passes.
- `npm test` passes.
- Stages 1-3 have focused tests.
- `observe()` returns non-stub `ObservationResult` values.
- No VLM code is called.
- `node dist/demo/run.js demo/screenshots/login_flow` prints real per-frame events when screenshots are present.
- The locked pipeline exports remain unchanged.
- No files owned by Person B were modified.
