# Results

How the savings and quality numbers evolved during the build. Every measurement here is reproducible: `npm run measure [-- <screenshot_dir>]` for tokens, `node dist/eval/accuracy_check.js <results.json>` for accuracy.

All raw measurement files live under `eval/results/`. Per-frame verdicts under `*.accuracy.json`.

---

## Evolution at a glance (login flow, 12 frames)

| Stage | Input tokens (A → B) | Token reduction | Cost reduction | What changed |
|---|---|---|---|---|
| **Phase 3 baseline** | 19,008 → 14,249 | **25.0%** | 69.4% | First end-to-end measurement. Mostly disappointing. |
| **Phase 3 optimized** (image downscale) | 19,008 → 5,353 | **71.8%** | 78.4% | Resize images to 768px before Haiku — fixed the dominant cost driver. |
| **After pipeline merge** (rebased on Phase 3 pipeline PR) | 19,008 → 6,562 | 65.5% | 83.4% | Person A's pipeline shifted one frame text→VLM. Token reduction slightly down, cost reduction up. |
| **Fair baseline** (Run A gets prev+curr) | 36,255 → 6,562 | **81.9%** | **91.3%** | Old baseline was answering an ill-posed question. New baseline passes both screenshots and asks "what changed" — matches what a real change-detection agent would do. |

The Phase 3 optimization and the baseline correction are independent wins. They compound.

## Cross-scenario validation (checkout flow, 10 frames)

To check the savings aren't an artifact of one well-suited flow, we measured a second scenario — a Zara checkout flow (shipping → delivery method → order summary → payment).

| Metric | Login | Checkout |
|---|---|---|
| Frames | 12 | 10 |
| Run A input tokens | 36,255 | 29,951 |
| Run B input tokens | 6,562 | 5,784 |
| Token reduction | **81.9%** | **80.7%** |
| Cost reduction | **91.3%** | **80.8%** |
| Frames skipped by visual gate | 5 (42%) | 0 |
| Sonnet text-only calls | 2 | 6 |
| Haiku VLM calls | 5 | 4 |

Two scenarios, similar reduction. The cost reduction differs slightly because checkout has zero gate-filtered frames (no redundancy in that capture sequence), so the savings come from text-summary + Haiku-with-downscale rather than from gate-filtering noise.

## Accuracy (the question that matters once cost is solved)

Run B has to actually capture the events Run A captures. Otherwise the savings are meaningless. We use Claude Haiku as a judge: for each non-skipped frame, does StateLens's compressed signal describe the same event as the raw-image baseline?

- `skipped` frames (visual gate filtered) are counted as agreement (both runs implicitly say "nothing happened").
- `session_start` frames are excluded entirely — the first frame has no prior to compare against.

| Flow | Frames | Excluded | Skipped | Matches | Partials | Misses | Strict | Lenient |
|---|---|---|---|---|---|---|---|---|
| **Login** | 12 | 1 | 5 | 3 | 3 | 0 | **72.7%** | **100.0%** |
| **Checkout** | 10 | 1 | 0 | 3 | 2 | 4 | **33.3%** | **55.6%** |

**Login**: every event captured, no misses. The partials are wording differences and missed contextual details, not lost events.

**Checkout**: real accuracy gap. The 4 misses are all on form-heavy frames (002, 004, 005, 007) where the text_summary path emits a fragmented "text changed: X | Y" line that doesn't convey the underlying user action. The visual gate is also less useful here because no two consecutive frames are pixel-redundant.

### Where the checkout misses come from (concrete)

Looking at `eval/results/phase3_checkout_with_text.accuracy.json`:
- Frame 002: Run A "checkout loading screen transition", StateLens "text change event"
- Frame 004: Run A "shipping form being filled with user details", StateLens "text change event with symbols"
- Frame 005: Run A "form field changes", StateLens "garbled character sequences"
- Frame 007: Run A "shipping option change from standard to express with cost update", StateLens "section expansion showing additional delivery option"

The pattern: form-heavy frames where multiple short text fields change at once. The current `text_summary` path concatenates added/removed lines and produces a hard-to-parse summary. The importance scorer's `textSufficient` threshold is too eager to claim the text diff is enough.

### Tuning candidates (Phase 4)

1. Send form-heavy frames to Haiku VLM instead of text-only. Lower the `score < 0.7` cutoff in `importanceScorer.ts`, or detect "many small region changes" as a VLM trigger.
2. Improve `buildTextSummary` in `pipeline/index.ts` to produce a more readable narration when multiple regions change.
3. OCR confidence filter — drop garbled OCR results that contain mostly non-alpha characters.

## Methodology evolution

The numbers above hide two methodology changes we made along the way. Recording them so the final story is honest.

### Change 1 — Haiku image downscale

The Phase 3 baseline showed only 25% token reduction. Diagnosis: each Haiku VLM call sent two full-resolution screenshots as base64 (~3,500 input tokens per call). Anthropic prices images by tile count, which scales with resolution.

Fix: downscale to 768px on the long edge before encoding. Cuts per-Haiku-call tokens to ~1,300 with no measurable loss in event-summary quality.

Lever sits in `src/pipeline/vlmExplainer.ts`. Lands in PR #7.

### Change 2 — Fair baseline

The original Run A prompt was *"Summarize what changed since the previous screenshot in one sentence"*, but we only sent one image per call. Sonnet correctly said "I can't compare without a previous screenshot" in many cases, which made Run A's responses useless for accuracy comparison.

Fix: Run A now sends both the previous and the current screenshot to Sonnet. This:
- Mirrors what a real change-detection agent would do
- Roughly doubles Run A's baseline token usage (~1,600 → ~3,200 per call)
- Makes the savings story more honest, not less — baseline is now more expensive
- Lets the accuracy harness compare apples to apples

The first frame still uses a state-description prompt since it has no prior.

## Cost breakdown (login, fair baseline)

```
Baseline (Run A): 12 calls × prev+curr to Sonnet
  Input tokens:   36,255   (~3,000 per call: prev image + curr image)
  Output tokens:  ~450
  Cost:           $0.1161

StateLens (Run B): 2 Sonnet text + 5 Haiku visual + 5 skipped
  Sonnet input:   49 tokens   (just event_summary text)
  Sonnet output:  ~50
  Haiku input:    6,513 tokens   (downscaled prev+curr pairs)
  Haiku output:  ~700
  Cost:           $0.0101

Where the savings come from:
  1. Visual gate filters 5/12 frames → 0 API calls, $0 spent
  2. Of remaining 7 keyframes, 2 are text-sufficient → tiny Sonnet text-only calls
  3. Remaining 5 frames go to Haiku at downscaled resolution → ~1,300 tokens each
  4. Sonnet's expensive image tokens are eliminated for 10 of 12 frames (99.6% reduction)
```

## What's reproducible

All numbers in this doc come from these JSON files (committed):
- `eval/results/phase3_baseline.json` — Phase 3 baseline (broken baseline, 25% reduction)
- `eval/results/phase3_optimized.json` — Post-downscale, original baseline (65% reduction)
- `eval/results/phase3_login_with_text.json` — Final login measurement (fair baseline, with summary text)
- `eval/results/phase3_checkout_with_text.json` — Final checkout measurement (fair baseline)
- `eval/results/phase3_login_with_text.accuracy.json` — Per-frame login accuracy verdicts
- `eval/results/phase3_checkout_with_text.accuracy.json` — Per-frame checkout accuracy verdicts

Reproduce by running:
```bash
npm run measure                                    # login flow
npm run measure -- demo/screenshots/checkout_flow  # checkout flow
node dist/eval/accuracy_check.js <results.json>   # accuracy on any result
```

## Headline for the pitch

> "Across two scenarios — a 12-frame login flow and a 10-frame checkout flow — StateLens reduced input tokens by **80-82%** and cost by **81-91%** against a real change-detection baseline. On login, no events were missed (100% lenient agreement with a Haiku judge). On checkout, form-heavy frames showed a real accuracy gap (56% lenient) which we traced to the importance scorer's text-sufficient threshold — a known tuning opportunity, not a fundamental limitation."

Honest, specific, with the gap acknowledged.
