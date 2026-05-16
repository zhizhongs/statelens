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
| **Phase 4 tuning** (OCR-reliability check) | 36,255 → 6,562 | **81.9%** | **90.1%** | Login distribution unchanged; checkout dropped 10pp token (more Haiku calls) but lenient accuracy +22pp. Trade tokens for honest summaries on form-heavy UIs. |

The Phase 3 optimization, baseline correction, and Phase 4 tuning are independent wins. They compound.

## Cross-scenario validation (checkout flow, 10 frames)

To check the savings aren't an artifact of one well-suited flow, we measured a second scenario — a Zara checkout flow (shipping → delivery method → order summary → payment).

**Final numbers (after Phase 4 tuning, post-PR-#11):**

| Metric | Login | Checkout |
|---|---|---|
| Frames | 12 | 10 |
| Run A input tokens | 36,255 | 29,951 |
| Run B input tokens | 6,562 | 9,025 |
| Token reduction | **81.9%** | **69.9%** |
| Cost reduction | **90.1%** | **81.2%** |
| Frames skipped by visual gate | 5 (42%) | 0 |
| Sonnet text-only calls | 2 | 4 |
| Haiku VLM calls | 5 | 6 |

Two scenarios, similar reduction. Cost reduction differs because checkout has zero gate-filtered frames (no consecutive redundancy in the capture sequence), so the savings come from text-summary + Haiku-with-downscale rather than from gate-filtering noise. The Phase 4 tuning intentionally pushed 2 form-heavy frames from text_summary to Haiku — that drops token reduction 10pp on checkout but lifts accuracy +22pp (see Accuracy section).

## Accuracy (the question that matters once cost is solved)

Run B has to actually capture the events Run A captures. Otherwise the savings are meaningless. We use Claude Haiku as a judge: for each non-skipped frame, does StateLens's compressed signal describe the same event as the raw-image baseline?

- `skipped` frames (visual gate filtered) are counted as agreement (both runs implicitly say "nothing happened").
- `session_start` frames are excluded entirely — the first frame has no prior to compare against.

**Final numbers (after Phase 4 tuning):**

| Flow | Frames | Excluded | Skipped | Matches | Partials | Misses | Strict | Lenient |
|---|---|---|---|---|---|---|---|---|
| **Login** | 12 | 1 | 5 | 4 | 2 | 0 | **81.8%** | **100.0%** |
| **Checkout** | 10 | 1 | 0 | 3 | 4 | 2 | **33.3%** | **77.8%** |

**Login**: every event captured, no misses. Strict went 72.7% → 81.8% (one partial → match) after tuning.

**Checkout**: real accuracy was 55.6% lenient pre-tune. The Phase 4 OCR-reliability check pushed form-heavy frames from text_summary to Haiku VLM, lifting lenient to **77.8%** (-2 misses). Strict held at 33.3% because the remaining gap is wording specificity (StateLens still uses more terse summaries than Sonnet's verbose ones) — not lost events.

### What the Phase 4 tuning fixed

Pre-tune, these frames produced fragmented summaries because tesseract.js mis-OCR'd Zara's stylized form fields as `"a / ® |"` and the importance scorer accepted it as "text-present":
- Frame 002: Run A "checkout loading screen transition", StateLens "text change event"
- Frame 004: Run A "shipping form being filled with user details", StateLens "text change event with symbols"
- Frame 005: Run A "form field changes", StateLens "garbled character sequences"

After tuning (`src/pipeline/importanceScorer.ts` `isTextReliable()` rejects garbage OCR), these frames route to Haiku and get coherent multi-event summaries. Two of the four prior misses became partials; two remain misses on small form-field deltas where Haiku-on-thumbnail still doesn't read every input value.

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

### Change 3 — OCR reliability check (Phase 4 tuning)

The Phase 3 accuracy harness revealed that on form-heavy frames (Zara checkout 002/004/005/007), tesseract.js produced garbage OCR (`"a / ® |"`) but the importance scorer counted it as "text-present, score 0.4" and routed to `text_summary`. The downstream summary was fragmented and the Haiku judge marked these frames MISS.

Fix: `isTextReliable()` rejects OCR output that is too short, too low in alphanumeric ratio, or fragmentary. When unreliable text is detected, `shouldCallVlm` fires at score >= 0.4 instead of 0.5. Form-heavy frames now route to Haiku.

Lever in `src/pipeline/importanceScorer.ts`. Lands in PR #11. Lifts checkout lenient accuracy 56% → 78% at the cost of 10pp token reduction (6 Haiku calls on checkout instead of 4).

## Cost breakdown (login, Phase 4 tuned)

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

**Phase 4 (current best — use these for the pitch):**
- `eval/results/phase4_login_tuned.json` — Login with Phase 4 OCR-reliability tuning
- `eval/results/phase4_checkout_tuned.json` — Checkout with Phase 4 tuning
- `eval/results/phase4_login_tuned.accuracy.json` — Per-frame login accuracy
- `eval/results/phase4_checkout_tuned.accuracy.json` — Per-frame checkout accuracy

**Phase 3 (the evolution that got us here, kept for the story):**
- `eval/results/phase3_baseline.json` — First measurement (broken baseline, 25% reduction)
- `eval/results/phase3_optimized.json` — Post-downscale, original baseline (65% reduction)
- `eval/results/phase3_login_with_text.json` — Pre-tune login (fair baseline)
- `eval/results/phase3_checkout_with_text.json` — Pre-tune checkout
- `eval/results/phase3_login_with_text.accuracy.json` — Pre-tune login verdicts
- `eval/results/phase3_checkout_with_text.accuracy.json` — Pre-tune checkout verdicts

Reproduce by running:
```bash
npm run measure                                    # login flow
npm run measure -- demo/screenshots/checkout_flow  # checkout flow
node dist/eval/accuracy_check.js <results.json>    # accuracy on any result
```

## Headline for the pitch

> "Across two scenarios — a 12-frame login flow and a 10-frame Zara checkout — StateLens reduced input tokens by **70-82%** and cost by **81-90%** against a real change-detection baseline (raw screenshots through Sonnet, every frame). On login, no events were missed (**100% lenient agreement** with a Haiku judge). On checkout — a form-heavy flow with zero gate-filterable frames — accuracy was 56% lenient before tuning; we identified the OCR-reliability failure mode and shipped a fix in 30 minutes that lifted it to **78%**, dropping token reduction 10pp in exchange. Both numbers come from real Anthropic API tokens, not estimates, and are reproducible with `npm run measure`."

Honest, specific, with the tuning trade openly shown.
