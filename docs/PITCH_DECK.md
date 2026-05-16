# StateLens Pitch Deck

Status: pitch content draft  
Audience: hackathon judges, developer-tool investors, AI tooling partners  
Goal: explain what is built now, prove the savings, and show agentic testing as the next wedge

## Slide 1 - Title

### StateLens

**The observation compression layer for UI agents.**

Computer-use agents waste money re-reading screenshots where nothing meaningful changed. StateLens turns screenshot streams into semantic state changes before the expensive model sees them.

**Proof point:** 80-90% cost reduction across two adversarial screenshot scenarios with 78-100% event-capture accuracy, measured with real Anthropic API usage.

**Visual direction:**  
One line pipeline: `screenshot stream -> StateLens -> compact events -> agent reasoning`

**Speaker note:**  
StateLens is not another browser agent. It is the layer every browser or computer-use agent should call before spending vision tokens.

---

## Slide 2 - The Problem

### Agents Are Paying To Rediscover The Same Screen

Modern UI agents usually run a loop:

```text
screenshot -> vision model reasons -> action -> screenshot -> vision model reasons again
```

That loop is expensive because:

- many consecutive screenshots are identical or nearly identical
- small UI changes often happen in one region, not the whole screen
- text changes like errors, warnings, and form validation can be extracted locally
- raw screenshot reasoning gives little persistent observability after the run

**Pain:** teams pay model prices for repeated visual context, then still have to debug what happened manually.

**Visual direction:**  
Stack of repeated screenshots, most dimmed, with a dollar sign on every frame.

**Speaker note:**  
The waste is not that vision is useless. The waste is using full vision as the default observation mechanism for every frame.

---

## Slide 3 - The Insight

### Most UI State Changes Can Be Compressed Before Vision

StateLens asks a cheaper question first:

```text
Did anything meaningful change?
If yes, where?
If text changed, what text?
Only if local signals are insufficient, call a small VLM.
```

This gives the agent a structured observation:

```json
{
  "changed": true,
  "keyframe": true,
  "event_type": "error_appeared",
  "event_summary": "Text appeared: \"Invalid password\"",
  "text_diff": { "added": ["Invalid password"], "removed": [] },
  "vlm_called": false
}
```

**Visual direction:**  
Before: huge screenshot. After: small JSON event card.

**Speaker note:**  
We are moving observation from pixels to state transitions.

---

## Slide 4 - What We Built

### A Six-Stage Screenshot Compression Pipeline

```text
current screenshot
  -> Stage 1: visual gate
  -> Stage 2: changed-region localization
  -> Stage 3: OCR text diff on changed crops
  -> Stage 4: importance scoring
  -> Stage 5: selective Haiku explanation
  -> Stage 6: timeline assembly
```

**Shipped capabilities:**

- hash + pixelmatch visual gate for redundant frames
- changed-region bounding boxes with semantic labels
- OCR only on changed crops, not whole screenshots
- rule-based importance scoring for keyframe selection
- selective VLM explanation for high-value visual-only states
- cumulative Haiku usage accounting for honest measurement
- per-session semantic timeline
- action-failure detection: expected-change actions that produce no UI change emit a structured `action_failed` event
- multi-language OCR: `STATELENS_OCR_LANGS` configures Tesseract for non-English UI flows, defaults to English

**Visual direction:**  
Six-stage architecture diagram with local stages in green and optional VLM in amber.

**Speaker note:**  
The pipeline is model-external. It works as a library, through MCP, and inside custom agent loops.

---

## Slide 5 - Product Surface

### Works As MCP, Library, And Agent Middleware

**MCP tools shipped:**

| Tool | What it does |
|---|---|
| `statelens_observe` | Analyze a screenshot against prior session state |
| `statelens_timeline` | Return the event timeline and cost metrics |
| `statelens_compare` | Compare any two screenshots directly |
| `statelens_reset` | Reset session state |

**Integration features shipped:**

- accepts local `screenshot_path`
- accepts in-memory `screenshot_base64`
- works in Cursor, Claude Code, Claude Desktop, and any MCP client
- exposes `routeObservation()` for code-enforced routing
- includes a Playwright-like `captureAndRoute()` adapter
- supports local no-key operation for non-VLM stages, with conservative routing on analysis errors

**Visual direction:**  
Three columns: MCP clients, local library, in-process adapter.

**Speaker note:**  
Closed clients can use the MCP tool with a policy prompt. Custom agents can enforce the route in code.

---

## Slide 6 - Real Numbers

### 80%+ Token Reduction. 81-90% Cost Reduction. 78-100% Accuracy. Two Adversarial Scenarios.

Measured with real Anthropic API token counts (Sonnet 4.6, Haiku 4.5 internally). Baseline = raw screenshots through Sonnet with a fair "what changed" prompt (prev + curr image to Sonnet per frame). Files: `eval/results/phase4_login_tuned.json` and `eval/results/phase4_checkout_tuned.json`.

| Metric | **Login** (12 frames) | **Checkout** (10 frames) |
|---|---:|---:|
| Baseline input tokens | 36,255 | 29,951 |
| StateLens input tokens | 6,562 | 9,025 |
| **Token reduction** | **81.9%** | **69.9%** |
| Baseline cost | $0.1162 | $0.0988 |
| StateLens cost | $0.0115 | $0.0186 |
| **Cost reduction** | **90.1%** | **81.2%** |
| Sonnet image tokens dropped | 100% (12 → 0) | 100% (10 → 0) |
| Frames filtered by visual gate | 5 / 12 (42%) | 0 / 10 |
| Sonnet text + Haiku VLM calls | 2 + 5 | 4 + 6 |
| **Accuracy (lenient agreement)** | **100.0%** | **77.8%** |
| Accuracy (strict agreement) | 81.8% | 33.3% |
| Misses (events lost) | **0** | 2 |

**Why two scenarios — they're adversarial.** Login has natural redundancy (cursor blinks, identical-frame moments) so the visual gate filters 5/12 and OCR text diffs handle most keyframes. Checkout has zero pixel-redundancy and stylized form fields that break OCR — there the savings come from routing form changes through cheap Haiku calls instead of full-resolution Sonnet. Same pipeline, different mechanisms, both deliver 80%+ token and 81%+ cost reduction.

**Accuracy** = does StateLens's compressed signal describe the same UI event as the raw-image baseline? Judged by Claude Haiku frame by frame against Sonnet's baseline summary. `skipped` frames count as agreement (both runs implicitly say "nothing happened"). First frame of each session excluded (no prior to compare against). Per-frame verdicts at `eval/results/phase4_*.accuracy.json`.

**Honest accounting.** Run B totals include every Haiku token StateLens consumes internally. No "shifted to a cheaper model" trick — if Haiku's tokens were excluded, the savings would look ~15pp better. We chose to count them against ourselves.

**Phase 4 tuning footnote.** Checkout lenient accuracy was 56% pre-tuning. We diagnosed garbage OCR ("a / ® |") on Zara's stylized form fields causing false `text_summary` routes, shipped an `isTextReliable()` check in `importanceScorer.ts`, and lifted accuracy to 78% with cost reduction holding at 81%. Full evolution in [`RESULTS.md`](../RESULTS.md). Reproducible: `npm run measure` and `npm run measure -- demo/screenshots/checkout_flow`.

**Visual direction:**  
Two side-by-side bar groups (Login | Checkout): one bar set for cost (baseline vs StateLens, with $ labels), one bar set for accuracy (lenient %). Footnote callouts: "5 frames filtered with zero AI calls" arrow on login, "form-fill OCR routed to Haiku" arrow on checkout.

**Speaker note:**  
Lead with the cost number (90% on login). Then immediately go to accuracy (100% lenient on login) before the audience asks "but does it work?" Use the two-scenario contrast to head off the "is this just an easy flow?" question — checkout was *harder* than login (no redundancy, bad OCR) and we still saved 81% cost. Mention the Phase 4 tuning trade openly: we made it worse on tokens (10pp) to make it better on accuracy (22pp).  We count Haiku tokens against ourselves — this is honest accounting.

---

## Slide 7 - Why It Matters Beyond Cost

### StateLens Makes Agent Runs Debuggable

Raw screenshots disappear into a model context. StateLens leaves a timeline:

```json
{
  "total_screenshots": 12,
  "keyframes": 7,
  "vlm_calls_made": 1,
  "events": [
    { "event_type": "session_start", "summary": "First screenshot in session" },
    { "event_type": "text_appeared", "summary": "Text appeared: \"Welcome back\"" },
    { "event_type": "error_appeared", "summary": "Text appeared: \"Invalid password\"" }
  ]
}
```

This helps developers answer:

- what changed?
- when did it change?
- did an action do nothing?
- which frames actually needed vision?
- where did the agent waste work?

The "did an action do nothing?" question is now a first-class event. When the agent passes an `actionLabel` it expected to mutate the UI and the screen does not change, StateLens emits:

```json
{
  "changed": false,
  "keyframe": true,
  "event_type": "action_failed",
  "event_summary": "Action \"click_submit\" produced no meaningful UI change; the action may have failed or the page may be stuck",
  "vlm_called": false
}
```

No OCR, no VLM, no false-positive `no_change` hiding a stuck page.

**Visual direction:**  
Timeline rail with event badges and skipped-frame markers.

**Speaker note:**  
The same compression that saves money also becomes observability for agent debugging.

---

## Slide 8 - Real-Time Agent Integration

### Middleware Beats A Prompt

Policy prompts help, but they are voluntary. The reliable path is code:

```ts
const { screenshot, observation, route } = await captureAndRoute(page, {
  sessionId: 'login_flow',
  actionLabel: 'click_submit',
});

if (route.route === 'skip_vision') {
  // spend zero model tokens
}

if (route.route === 'use_text_observation') {
  await reasoningModel({ text: route.context });
}

if (route.route === 'use_full_vision') {
  await reasoningModel({ image: screenshot });
}
```

The `actionLabel` is no longer just a hint. Mutating labels (`click_submit`, `save_*`, `fill_*`, `expect_change:*`) flip an unchanged screen from `no_change` to `action_failed`. Passive labels (`wait`, `observe:*`, `passive:*`) keep their quiet path.

**What is shipped now:**

- generic routing helper
- Playwright-like screenshot adapter
- conservative fallbacks for invalid screenshots and analysis errors
- optional screenshot-base64 MCP path for agents that hold images in memory
- action-label classifier that distinguishes mutating from passive actions
- `STATELENS_OCR_LANGS` env var for non-English UI flows

**Visual direction:**  
Decision tree with three routes: skip, text, full vision.

**Speaker note:**  
The folder demo proves the pipeline. The adapter proves how this works in real-time screenshot loops.

---

## Slide 9 - Next Wedge: Agentic Testing

### StateLens For Self-Healing Test Agents

This is not implemented yet, but it is the clearest product expansion.

Agentic testing loops repeatedly inspect, retry, and repair UI flows:

```text
test agent explores website
  -> generates or runs Playwright tests
  -> test fails
  -> healer replays the failing flow
  -> StateLens compresses repeated observations
  -> agent receives compact failure context
```

Planned integration:

- Playwright Test fixture: `lens.step("submit form", action)`
- StateLens timeline attached to test reports
- compact healer context for failures
- screenshots only forwarded when route is `use_full_vision`
- Stagehand adapter as a second target

The Phase 4 `action_failed` event is the first healer signal already shipped: when the test agent clicks submit and the screen does not move, the timeline records *the action that did nothing* — not just a quiet `no_change` gap.

**Positioning:**  
Playwright snapshots already handle normal DOM-heavy tests efficiently. StateLens focuses on screenshot-heavy fallback, visual UI, canvas, charts, custom widgets, and healer loops.

**Visual direction:**  
Testing loop diagram: plan, generate, run, fail, heal, rerun, with StateLens compressing observation steps.

**Speaker note:**  
We should pitch this as roadmap, not current implementation. The core pipeline and routing primitives make it a natural next step.

---

## Slide 10 - Why StateLens Wins

### Model-External, Inspectable, And Easy To Adopt

Existing research optimizes inside a specific VLM. StateLens optimizes outside the model.

| Approach | Tradeoff |
|---|---|
| Model-internal token pruning | powerful, but model-specific and invisible |
| Raw Playwright snapshots | great for accessible DOM, less helpful for pixel-heavy states |
| Full screenshot reasoning | general, but expensive and hard to debug |
| StateLens | model-agnostic, inspectable, and installable as MCP or middleware |

**Moat in practice:**

- local-first diffing pipeline
- structured event timeline
- honest VLM usage accounting
- MCP distribution
- in-process route API for custom agents
- credible path into agentic testing and self-healing workflows

**Close:**  
StateLens is the universal observation layer for UI agents.

**Visual direction:**  
Four-quadrant matrix: model-specific vs model-agnostic, opaque vs inspectable.

**Speaker note:**  
The thesis is simple: do not make every model relearn the same unchanged screen. Put an observation layer in front of them.

---

## Optional Appendix - Feature Inventory

### Shipped Now

- Stage 1 visual gate (hash + pixelmatch)
- Stage 2 spatial diff localization
- Stage 3 OCR text diff on changed crops only
- Stage 4 importance scorer with Phase 4 OCR-reliability check
- Stage 5 selective VLM explanation (Haiku, 768px-downscaled images)
- Stage 6 timeline assembly
- VLM cumulative usage tracking for honest accounting
- Phase 3 reliability fallbacks (invalid screenshot, analysis error)
- MCP server with 4 tools
- path and base64 screenshot input
- A/B token measurement harness (`npm run measure`)
- Haiku-judged accuracy harness with strict / lenient scoring
- two locked baselines: login (12 frames) and checkout (10 frames)
- saved per-frame verdicts under `eval/results/phase4_*.accuracy.json`
- route helper for custom agents (`routeObservation()`)
- Playwright-like capture adapter (`captureAndRoute()`)
- live Playwright demo (`demo/agent_loop/playwright_login.ts`)
- action-failure detection via `actionLabel` classifier (`action_failed` event)
- multi-language OCR via `STATELENS_OCR_LANGS`
- `RESULTS.md` documenting full measurement evolution

### Pitch As Roadmap

- Playwright Test fixture
- healer-loop failure context
- test report artifacts
- Stagehand adapter
- agentic testing cost dashboard

### Do Not Claim Yet

- automatic interception inside closed clients
- universal savings on non-screenshot Playwright tests
- completed Playwright Test Agent integration
- completed Stagehand integration
- production browser extension
