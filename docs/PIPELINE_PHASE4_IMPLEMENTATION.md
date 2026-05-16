# Pipeline Phase 4 Implementation Design

Owner: Person A - Pipeline Engineer  
References: [`../DESIGN.md`](../DESIGN.md), [`./ROLE_PIPELINE.md`](./ROLE_PIPELINE.md), [`./PIPELINE_PHASE2_IMPLEMENTATION.md`](./PIPELINE_PHASE2_IMPLEMENTATION.md), [`./POST_PHASE3_AGENT_INTEGRATION.md`](./POST_PHASE3_AGENT_INTEGRATION.md)  
Phase: 4, hours 24-40

## Objective

Phase 4 adds stretch behavior to the completed pipeline without changing the locked integration contract:

```text
current screenshot Buffer
  -> session previous screenshot lookup
  -> Stage 1 visual gate
  -> Phase 4 no-change action failure detection
  -> Stages 2-6 unchanged
  -> ObservationResult
```

The primary Person A deliverable is **failure detection**: when an action that was expected to change the UI produces no meaningful visual change, StateLens should report a structured `action_failed` event instead of a generic `no_change`.

The secondary Person A deliverable is **multi-language OCR**: keep English as the default, but allow the pipeline to initialize Tesseract with an explicit language set for non-English UI flows. Do failure detection first, then add OCR language configuration.

## Scope

In scope:

- `src/pipeline/index.ts`, to route no-change frames with meaningful `actionLabel` values to `action_failed`
- Optional `src/pipeline/actionExpectation.ts`, if the action-label classifier is clearer as a small pure helper
- `src/pipeline/ocrDiff.ts`, for multi-language OCR configuration
- `tests/pipeline/*.test.ts`

Out of scope:

- MCP server and CLI changes in `src/server.ts` and `src/index.ts`
- Adapter, Playwright, demo, report, eval, README, and pitch work owned by Person B
- Any new required public fields in `ObservationResult` or `TimelineEvent`
- Any dependency additions without coordinating with Person B first

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

Do not rename `ObservationResult`, `TimelineResult`, `TimelineEvent`, `ChangedRegion`, `TextDiff`, or `VlmUsage`.

Phase 4 may add one new stable `event_type` string:

```text
action_failed
```

Coordinate with Person B before changing existing event strings such as `invalid_screenshot`, `analysis_error`, `no_change`, or `minor_change`, because the routing helper keys off them.

## Starting Point After Phase 3

The pipeline already provides:

- Safe user-facing observations for invalid screenshots and analysis errors.
- A Stage 1 no-change path that returns `event_type: 'no_change'` and does not append to the timeline.
- An unused `actionLabel` parameter in `observe()`.
- Stable `keyframe` / `vlm_called` semantics consumed by `routeObservation()`.
- `prewarmPipeline()` and `prewarmOcrWorker()` for OCR startup cost management.

Phase 4 should preserve all existing behavior when `actionLabel` is absent or passive.

## Target 1 - Failure Detection

Purpose: detect the high-value agent failure mode from `DESIGN.md` Section 15 and `ROLE_PIPELINE.md` Phase 4:

```text
agent action happened
  -> screenshot is unchanged
  -> action probably failed, was blocked, or left the page stuck
```

### Behavior

Only the Stage 1 no-change branch changes.

Current behavior:

```ts
if (!gate.changed) {
  return no_change;
}
```

Phase 4 behavior:

```ts
if (!gate.changed) {
  if (shouldExpectVisualChange(actionLabel)) {
    return action_failed;
  }
  return no_change;
}
```

`action_failed` observation shape:

```ts
{
  changed: false,
  keyframe: true,
  importance_score: 0.6,
  event_type: 'action_failed',
  event_summary: 'Action "click_submit" produced no meaningful UI change; the action may have failed or the page may be stuck',
  changed_regions: [],
  text_diff: { added: [], removed: [] },
  vlm_called: false,
  latency_ms
}
```

Important semantics:

- `changed` stays `false` because the UI did not change.
- `keyframe` is `true` because the no-change result is semantically important.
- The event is appended to the timeline.
- No OCR or VLM call should happen for `action_failed`.
- The previous screenshot state should be handled exactly like `no_change`; no special reset.
- First frame in a session still returns `session_start`, even if `actionLabel` is present.
- Invalid screenshots and analysis errors must not be converted to `action_failed`.

### Action Label Classifier

Implement the classifier as a pure helper. It can live privately in `index.ts` or in `src/pipeline/actionExpectation.ts`:

```ts
export function shouldExpectVisualChange(actionLabel?: string): boolean
```

Suggested rules:

1. Missing or blank label returns `false`.
2. Explicit positive prefixes return `true`:
   - `expect_change:`
   - `expect-change:`
   - `mutating:`
3. Explicit passive prefixes return `false`:
   - `passive:`
   - `no_change_ok:`
   - `observe:`
4. Passive labels return `false`:
   - `wait`
   - `sleep`
   - `poll`
   - `observe`
   - `screenshot`
   - `hover`
5. High-confidence mutating labels return `true`:
   - labels containing `submit`, `save`, `login`, `sign_in`, `checkout`, `confirm`, `delete`, `upload`, `navigate`, `goto`, `reload`
   - labels beginning with action verbs such as `type_`, `fill_`, `select_`, `press_`, `drag_`, `drop_`

Keep the heuristic conservative. A plain `click` can focus an input or close a menu without producing a meaningful visual change, so prefer explicit labels like `expect_change:click_submit` or semantic labels like `click_submit`.

### Timeline Recording

`recordKeyframe()` currently assumes `changed: true`, so use one of these approaches:

- Add a private `recordTimelineEvent()` helper and let `recordKeyframe()` call it.
- Or add a private `recordActionFailed()` helper for this single important no-change event.

The timeline event should be:

```ts
{
  step: session.totalScreenshots,
  event_type: 'action_failed',
  summary,
  text_diff: { added: [], removed: [] },
  regions: [],
  vlm_used: false
}
```

This preserves the current `TimelineEvent` shape.

### Router Compatibility

The existing router treats `changed === false` as `skip_vision`, so `action_failed` should still avoid downstream vision calls. The caller still receives the `event_type` and summary in the route reason.

If Person B wants `action_failed` to route as `use_text_observation` with a richer context string, that is an adapter change and should be coordinated separately.

## Target 3 - Multi-Language OCR

Purpose: show StateLens can extract text changes from non-English UI, using the tesseract.js language support called out in `ROLE_PIPELINE.md`.

Implementation:

- Keep the default language as `eng`.
- Add environment configuration:

```text
STATELENS_OCR_LANGS=eng+spa
```

- Pass the configured value to `createWorker()`.
- Reuse the same singleton worker behavior.
- Do not add a new parameter to `observe()`.
- Do not make unit tests depend on downloading OCR language data.
- Document that the runtime must have the requested Tesseract language data available.

Tests:

- Default worker initializes with `eng`.
- `STATELENS_OCR_LANGS=eng+spa` initializes with `eng+spa`.
- `resetOcrWorker()` allows tests to switch language configuration.
- Empty-region calls still return `{ added: [], removed: [] }` without initializing Tesseract.

## Test Design

Keep the main suite deterministic. Mock Tesseract and Anthropic exactly like the existing pipeline tests.

### `index.test.ts`

Add cases:

- Identical second frame without `actionLabel` still returns `no_change` and does not add a timeline event.
- Identical second frame with `expect_change:click_submit` returns `action_failed`.
- `action_failed` has `changed: false`, `keyframe: true`, `importance_score: 0.6`, `vlm_called: false`, and empty regions/text diff.
- `action_failed` appends exactly one timeline event after `session_start`.
- Passive labels such as `wait`, `observe:screenshot`, and `passive:poll` still return `no_change`.
- First frame with `expect_change:*` still returns `session_start`.
- Invalid screenshot after an expected-change action still returns `invalid_screenshot` and preserves prior state.

### Optional `actionExpectation.test.ts`

If the classifier is split into its own file, test it directly:

- `undefined`, empty string, and whitespace return `false`.
- Explicit positive prefixes return `true`.
- Explicit passive prefixes return `false`.
- High-confidence action labels return `true`.
- Ambiguous `click` returns `false`.

### `ocrDiff.test.ts`

Mock `createWorker()` and verify the language string passed to it.

## Performance Targets

| Path | Target | Notes |
|---|---:|---|
| Failure detection classifier | `<1ms` | Pure string matching. |
| `action_failed` observe path | close to Stage 1 no-change cost | Must not run OCR or VLM. |
| Multi-language OCR | same as existing OCR after warmup | More language data may increase worker startup time. |

## Failure Handling

- Missing or malformed `actionLabel` should behave like no label.
- Classifier bugs should not throw out of `observe()`.
- `action_failed` should not mask `invalid_screenshot` or `analysis_error`.
- Multi-language OCR failures should preserve the existing OCR failure behavior.

## Implementation Order

1. Run `npm run build` and `npm test` against the Phase 3 code.
2. Add the action-label expectation helper.
3. Add tests for passive, explicit, and high-confidence labels.
4. Modify the Stage 1 no-change branch in `observe()`.
5. Add `action_failed` timeline recording without changing public types.
6. Update `index.test.ts`.
7. Add `STATELENS_OCR_LANGS` support in `ocrDiff.ts`.
8. Update `ocrDiff.test.ts` for default and configured language initialization.
9. Run `npm run build`.
10. Run `npm test`.
11. Run the demo or measurement flow used at the Phase 3 checkpoint and confirm headline behavior still works.

## Phase 4 Merge Checkpoint

At hour 40, stop and verify:

1. `npm run build` passes.
2. `npm test` passes.
3. The login-flow demo still produces the expected semantic timeline.
4. Expected-change no-op actions produce `action_failed`.
5. Passive no-op observations still produce `no_change`.
6. No new VLM calls are introduced by the failure-detection path.
7. OCR language configuration defaults to `eng`.
8. `STATELENS_OCR_LANGS` changes the language string passed to Tesseract in tests.
9. No Person B-owned files were modified.

## Definition of Done

Phase 4 is done for Person A when:

- `action_failed` is implemented, tested, and visible in the timeline.
- Existing `no_change`, `minor_change`, `invalid_screenshot`, and `analysis_error` behavior remains stable.
- `observe()` still has the locked signature.
- `getTimeline()`, `resetSession()`, `getVlmCumulativeUsage()`, and `resetVlmCumulativeUsage()` still behave as before.
- The failure-detection path calls neither OCR nor VLM.
- OCR worker initialization supports `STATELENS_OCR_LANGS` and still defaults to `eng`.
- `npm run build` passes.
- `npm test` passes.
- The headline demo is not destabilized.
