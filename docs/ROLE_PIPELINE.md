# Person A — Pipeline Engineer

You own the `src/pipeline/` library. Pure TypeScript, no MCP, no API integration, no demo work. Your output is consumed by Person B's MCP server and measurement harness through a locked interface.

## Files You Own

```
src/pipeline/
├── index.ts             ← orchestrator + integration contract
├── visualGate.ts        ← Stage 1
├── spatialDiff.ts       ← Stage 2
├── ocrDiff.ts           ← Stage 3
├── importanceScorer.ts  ← Stage 4
├── vlmExplainer.ts      ← Stage 5  (CRITICAL: cumulative usage counter)
└── timeline.ts          ← Stage 6
src/utils/image.ts
tests/pipeline/*.test.ts
```

## Files You Do NOT Touch

- `src/server.ts`, `src/index.ts` (CLI) — Person B
- `eval/`, `demo/`, `README.md` — Person B
- `package.json` — coordinate with Person B before adding new deps

## Integration Contract (Locked, Hour 1)

This is the only surface Person B sees. Do NOT change these signatures without explicit agreement.

```typescript
// src/pipeline/index.ts

export async function observe(
  screenshotBuffer: Buffer,
  sessionId?: string,
  actionLabel?: string
): Promise<ObservationResult>;

export function getTimeline(sessionId: string): TimelineResult;
export function resetSession(sessionId: string): void;

// Required for honest accounting in eval/measure_tokens.ts:
export function getVlmCumulativeUsage(): { input_tokens: number; output_tokens: number };
export function resetVlmCumulativeUsage(): void;
```

Types `ObservationResult`, `TimelineResult`, `ChangedRegion`, `TextDiff`, `VlmUsage` are already defined in the stub. Do not rename.

## Reference

For every stage, the spec is in `../DESIGN.md` Section 4. Each subsection has:
- Purpose
- Implementation pseudocode
- Latency target
- Key optimizations

Pin `DESIGN.md` as `@` context in every Cursor Composer session.

---

## Phase 1: Pipeline Foundation (Hours 0–6)

**Goal:** A buffer goes in, a structured diff comes out. No VLM yet.

### Tasks

1. **Hour 0** — `cd ~/statelens && npm install && npm run build`. Must succeed against the stubs. Fix any TypeScript errors.
2. **Hour 0-1** — Implement Stage 1 (`visualGate.ts`) per `DESIGN.md` §4.2. Use the Cursor prompt below.
3. **Hour 1-2** — Write `tests/pipeline/visualGate.test.ts`. Cases: identical buffers → `changed: false, gate: 'hash_exact'`; tiny diff → `gate: 'pixelmatch'`; large diff → `changed: true`.
4. **Hour 2-4** — Implement Stage 2 (`spatialDiff.ts`) per §4.3. Reuse the pixelmatch diff image from Stage 1 if you can (perf optimization). Tests: no change, single region, multi-region, full-screen.
5. **Hour 4-6** — Implement Stage 3 (`ocrDiff.ts`) per §4.4. **CRITICAL**: only OCR cropped regions, never the full screenshot. Lazy-init the tesseract worker. Tests: text added, text removed, no change in text-bearing region.

### Phase 1 Cursor Prompts

**Stage 1 — visualGate.ts**

```
@DESIGN.md

Implement src/pipeline/visualGate.ts per Section 4.2.

The stub already exports the GateResult interface. Replace the throw with the real implementation:
- Resize both buffers to 640×360 raw RGBA via sharp
- MD5 hash both. If identical → {changed: false, gate: 'hash_exact', distance: 0}
- Otherwise pixelmatch with threshold 0.1, compute diffPercent
- If diffPercent < 0.02 → {changed: false, gate: 'pixelmatch', diffPercent}
- Else → {changed: true, gate: 'passed', diffPixels, diffPercent}

Acceptance: identical-buffer case <5ms, npm run build passes, no GPU/network deps.
```

**Stage 2 — spatialDiff.ts**

```
@DESIGN.md

Implement src/pipeline/spatialDiff.ts per Section 4.3.

The stub already exports classifyRegion(). Implement spatialDiff() to:
- Run pixelmatch on the raw buffers, get a diff image
- Connected component analysis on the diff image: find contiguous changed-pixel clusters
- For each cluster with area >= minArea (default 500), compute bounding box {x, y, w, h}
- Apply classifyRegion() to each
- Return ChangedRegion[]

Implementation note: pixelmatch's diff image marks changed pixels in red. Scan for red pixels and group them with flood-fill or scan-line connected components.

Acceptance: returns ChangedRegion[] with labels, handles no-change case (returns []), handles full-screen change.
```

**Stage 3 — ocrDiff.ts**

```
@DESIGN.md

Implement src/pipeline/ocrDiff.ts per Section 4.4.

Implementation:
- Module-level singleton: tesseract.js Worker, lazy-init English
- For each region: sharp.extract({left: r.x, top: r.y, width: r.w, height: r.h}) from both buffers
- OCR each crop, split into trimmed non-empty lines, collect into Sets
- Return {added: [...currTexts \ prevTexts], removed: [...prevTexts \ currTexts]}

CRITICAL: never OCR the full screenshot. Only crops. Stage 2 gives us regions exactly for this reason.

Acceptance: pre-warmed call <200ms on 400×60 crop; 0-region case returns empty diff.
```

### Phase 1 Merge Checkpoint (Hour 6) — REQUIRED

Both you and Person B stop coding and verify together:

1. `git pull origin main` (both)
2. You demo: `node dist/demo/run.js demo/screenshots/login_flow` — prints diffs with region labels and text changes for each of the 14 screenshots
3. Person B demos: StateLens appears in Cursor's MCP panel
4. Both: `npm test` passes
5. Decide together: any interface tweaks needed? If yes, change them NOW before Phase 2, not later.
6. Both commit + push.

---

## Phase 2: Intelligence (Hours 6–14)

**Goal:** Pipeline decides what's important and selectively calls VLM.

### Tasks

1. **Hour 6-8** — Stage 4 (`importanceScorer.ts`) per §4.5. Rule-based, no ML. Tests: empty diff scores low; error keywords boost score; large region boosts score; modal region boosts score.
2. **Hour 8-11** — Stage 5 (`vlmExplainer.ts`) per §4.6. **CRITICAL: instrument `cumulativeUsage` counter** so Person B's measurement harness can include Haiku tokens. The stub already has the counter scaffolding — populate it after every API call.
3. **Hour 11-14** — Stage 6 (`timeline.ts`) per §4.7. The `SessionTimeline` class is already stubbed; wire it into `observe()` in `src/pipeline/index.ts` to replace the stub return.
4. **Hour 13-14** — Replace the stub `observe()` in `src/pipeline/index.ts` with the real orchestrator that pipes Stages 1→6 together per `DESIGN.md` §5.2.

### Phase 2 Cursor Prompts

**Stage 4 — importanceScorer.ts**

```
@DESIGN.md

Implement src/pipeline/importanceScorer.ts per Section 4.5.

Replace the throw in importanceScore() with:
- Start score = 0
- If textDiff.added.length > 0: +0.4. If error keywords (error/invalid/failed/denied/warning/required) in added text: +0.2
- If total region area > 10% of screen: +0.3
- If any region has label 'center modal': +0.1
- textSufficient = textDiff.added.length > 0 && score < 0.7
- shouldCallVlm = score > 0.5 && !textSufficient
- Return { score, textSufficient, shouldCallVlm }

Acceptance: 5 test cases covering each scoring contributor.
```

**Stage 5 — vlmExplainer.ts (critical: usage tracking)**

```
@DESIGN.md

Implement src/pipeline/vlmExplainer.ts per Section 4.6.

The stub already has cumulativeUsage scaffolding. Implement vlmExplain():
- Use @anthropic-ai/sdk with claude-haiku-4-5-20251001
- Send both screenshots (base64) + the prompt from Section 4.6 / Section 10
- Parse the JSON response
- AFTER EVERY API CALL, ADD response.usage.input_tokens and response.usage.output_tokens to cumulativeUsage. This is non-negotiable — the measurement harness depends on it for honest accounting (Section 11.1).

Acceptance: returns parsed VlmExplanation; getCumulativeUsage() reflects every call; resetCumulativeUsage() clears the counter.
```

**Stage 6 — Orchestrator in src/pipeline/index.ts**

```
@DESIGN.md

Replace the stub observe() in src/pipeline/index.ts with the real orchestrator per Section 5.2.

Flow:
1. Get/create SessionTimeline for sessionId, incrementTotal()
2. prev = session.getPrevScreenshot(); setPrevScreenshot(curr)
3. If !prev → return session_start event with changed: true
4. Stage 1: visualGate(prev, curr). If !changed → return no_change event
5. Stage 2: spatialDiff(prev, curr) → regions
6. Stage 3: ocrDiff(prev, curr, regions) → textDiff
7. Stage 4: importanceScore(regions, textDiff, w, h) → scoring
8. If scoring.score < 0.3 → return minor_change (changed: true, keyframe: false)
9. If scoring.textSufficient → build text-based event summary, vlmCalled=false
10. Else if scoring.shouldCallVlm → vlmExplain(prev, curr, regions), vlmCalled=true
11. Else → generic "ui_change" event
12. session.addEvent(...)
13. Return ObservationResult with all fields filled

Also wire up getTimeline(sessionId) and resetSession(sessionId) against the sessions Map.

Acceptance: full pipeline runs end-to-end on demo screenshots; npm run measure (Person B's harness) produces non-stub numbers.
```

### Phase 2 Merge Checkpoint (Hour 14) — REQUIRED

The headline-number moment.

1. `git pull origin main` (both)
2. **Run `npm run measure` together.** This is the empirical proof. Numbers must show real Sonnet token reduction AND honest Haiku accounting.
3. Save the output to `eval/results/phase2_baseline.json`. This is your "we shipped" milestone.
4. If numbers look wrong (>0 vs expected, or savings <30%), debug together NOW. Common bug: not resetting `cumulativeUsage` between runs.
5. Both commit + push.

---

## Phase 3: Polish & Reliability (Hours 14–24)

**Goal:** Demo runs reliably 3+ times. Edge cases handled. Second screenshot scenario works.

### Tasks

1. **Hour 14-17** — Performance tuning. Profile each stage (`console.time`), ensure visualGate <5ms, ocrDiff <200ms warm. Pre-warm the tesseract worker on server start.
2. **Hour 17-20** — Edge cases: corrupted images, mismatched dimensions, missing files, very long screenshot sequences (memory), unicode in OCR. Add error handling that returns a sensible Observation, never throws.
3. **Hour 20-24** — Second screenshot scenario (provided by Person B). Run it through, fix any regressions. Tune importance thresholds if needed.

### Phase 3 Merge Checkpoint (Hour 24) — REQUIRED

1. Run the full Cursor live demo (Person B drives) 3 times back to back. Must succeed every time.
2. Run `npm run measure` against both scenarios. Numbers locked in `eval/results/`.
3. Both commit + push.

---

## Phase 4: Stretch (Hours 24–40)

Pick from `DESIGN.md` §15 in priority order. Your best targets as Person A:

1. **Failure detection** (high impact): detect when UI didn't change after an action (click failed, page stuck). Add a new event type `action_failed`.
2. **CLIP semantic similarity** as Stage 1.5: catches visual-only semantic redundancy that pHash misses.
3. **Multi-language OCR**: tesseract.js supports 100+ languages — show non-English UI.

Skip stretch goals that touch demo/MCP server work — those are Person B's territory.

### Phase 4 Merge Checkpoint (Hour 40) — REQUIRED

Whatever stretch goals you finished are stable, tested, and don't break the headline demo. If something half-finished is breaking the main flow, revert it.

---

## Phase 5: Pitch (Hours 40–48)

Joint work with Person B. Your responsibilities:

- Be ready to answer technical questions: "how does the OCR not OCR the whole image?", "what happens if pHash gives a false negative?", "why a rule-based scorer instead of a learned one?"
- Help Person B explain the pipeline diagram on slides
- Stand next to the demo machine — if something errors mid-demo, you debug

---

## Daily Discipline

- Pin `DESIGN.md` and this doc as `@` context in every Cursor Composer session
- One stage per Composer session — never "build the whole pipeline"
- Always write tests immediately after a stage lands
- `npm test && npm run build` before every push
- `git pull` before `git push`
- Never modify `src/server.ts` or `eval/` files — those are Person B's
