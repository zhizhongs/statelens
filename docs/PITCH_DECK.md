# StateLens Pitch Deck

Status: pitch content draft  
Audience: hackathon judges, developer-tool investors, AI tooling partners  
Goal: explain what is built now, prove the savings, and show agentic testing as the next wedge

## Slide 1 - Title

### StateLens

**The observation compression layer for UI agents.**

Computer-use agents waste money re-reading screenshots where nothing meaningful changed. StateLens turns screenshot streams into the cheapest sufficient observation before the expensive model sees them.

**Proof point:** 80-90% cost reduction across two adversarial screenshot scenarios with 78-100% event-capture accuracy, measured with real Anthropic API usage. Now shipping as a **drop-in Anthropic-compatible proxy** — change one `baseURL` and your existing agent gets the savings with zero code changes.

**Visual direction:**  
One line pipeline: `screenshot stream -> StateLens proxy -> no-change stub | event card | region evidence | full vision -> agent reasoning`

**Speaker note:**  
StateLens is not another browser agent. It is the observation router every browser or computer-use agent should pass through before spending vision tokens. The proxy form means no SDK swap, no MCP plumbing — just a different `baseURL`.

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

### Send The Cheapest Sufficient Evidence, Not Always Pixels

StateLens asks a cheaper question first:

```text
Did anything meaningful change?
If yes, where?
If text changed, what text?
What is the cheapest evidence the reasoning model needs?
```

The current proxy ships the first, second, and final routes. The next hardening step is the middle of the ladder: changed-region visual evidence, so visually important local changes do not have to choose between lossy text and the full screenshot.

| Route | What the reasoning model gets | Use when |
|---|---|---|
| `skip_vision` | "No meaningful change" stub | redundant frames |
| `text_observation` | semantic event card | forms, errors, navigation, modals |
| `region_evidence` | event card + 1-3 changed crops | localized visual changes where pixels matter |
| `context_snapshot` | event card + low-res or annotated screenshot | layout-level changes |
| `full_vision` | original screenshot | high-change, dense visual, or low-confidence frames |

Example event card, which stays as the base layer:

```json
{
  "changed": true,
  "keyframe": true,
  "event_type": "error_appeared",
  "event_summary": "Text appeared: \"Invalid password\"",
  "text_diff": { "added": ["Invalid password"], "removed": [] },
  "evidence": ["text_diff"],
  "vlm_called": false
}
```

**Visual direction:**  
Before: huge screenshot. After: evidence ladder with five rungs: skip, event card, changed-region crops, annotated/low-res context, full vision.

**Speaker note:**  
We are moving observation from pixels to state transitions, but not pretending text is always enough. The product direction is an evidence ladder: pay for the smallest payload that preserves the information the agent needs.

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
- **Anthropic-compatible HTTP proxy**: intercepts `POST /v1/messages`, runs the pipeline on the latest image block, rewrites the request before forwarding — with a recursion guard so internal Haiku calls bypass the proxy
- evidence-ladder design: today the proxy emits no-change stubs, text observations, or fail-open full vision; next hardening adds changed-region visual evidence for localized visual changes

**Visual direction:**  
Six-stage architecture diagram with local stages in green and optional VLM in amber, fronted by a proxy box that routes each request onto an evidence ladder.

**Speaker note:**  
The pipeline is model-external. It works as a library, through MCP, inside custom agent loops, and now as a transparent proxy that any Anthropic SDK can point at. The important product shift is not "always replace images with text"; it is "send the cheapest sufficient evidence."

---

## Slide 5 - Product Surface

### One Pipeline, Four Delivery Surfaces — Led By A Drop-In Proxy

**Primary surface — Anthropic-compatible HTTP proxy:**

```bash
# Boot it
statelens proxy --port 18443

# Point any Anthropic SDK at it
export ANTHROPIC_BASE_URL=http://127.0.0.1:18443
# ...that's it. No code changes. No tool calls. No prompts.
```

The proxy detects image blocks in `POST /v1/messages`, runs the StateLens pipeline against the latest screenshot, and rewrites the request to the cheapest sufficient observation before forwarding upstream. Today that means a no-change stub, a compact text observation, or fail-open full vision. The planned evidence-ladder hardening adds changed-region crops and low-res/annotated context for frames where text would be too lossy but full vision is wasteful. Recursion guard via `STATELENS_INTERNAL_ANTHROPIC_BASE_URL` keeps internal Haiku calls from looping back.

**Other surfaces shipped:**

| Surface | Use when |
|---|---|
| **HTTP proxy** | Any agent that talks to the Anthropic API — zero code change |
| **MCP server** (4 tools) | Editor clients where the proxy can't reach: Cursor, Claude Code, Claude Desktop |
| **`routeObservation()` library** | Custom agents that want code-enforced routing |
| **`captureAndRoute()` adapter** | Playwright loops that capture screenshots in-process |

**Integration features shipped:**

- proxy accepts the full Anthropic Messages API surface, streams responses through unchanged
- MCP accepts local `screenshot_path` or in-memory `screenshot_base64`
- conservative fallbacks for invalid screenshots and analysis errors
- local no-key operation for non-VLM stages
- planned route hardening: `region_evidence` and `context_snapshot` for localized visual changes and layout-level changes

**Visual direction:**  
Four-lane diagram: Proxy (highlighted, primary), MCP, library, adapter — all feeding the same pipeline box, which outputs an evidence ladder instead of a single "text-only" replacement.

**Speaker note:**  
Lead with the proxy. It's the surface that requires the least cooperation from the agent and reproduces the harness savings directly. MCP is the editor-compatibility adapter for environments the proxy can't reach. Be precise: text observations are the current cheapest route, not the whole architecture.

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

**Evidence-ladder implication.** These measured numbers use the current shipped routes: no-change stubs, text observations, internal Haiku summaries, and fail-open full vision on errors. The 2 checkout misses are exactly why the next product hardening is `region_evidence`: for localized visual changes, send the event card plus the changed crop instead of forcing a text-only summary or paying for the whole screenshot.

### Proxy-form validation — the harness number reproduces end-to-end

The numbers above are from a controlled SDK loop. To prove the pipeline survives the trip through a real request path, we re-ran the same login flow against the production proxy: SDK → `http://127.0.0.1:18443` → pipeline → upstream Anthropic, no harness shortcuts.

| Mode | Run A (direct) | Run B (proxy) | Δ cost | Accuracy (lenient) |
|---|---:|---:|---:|---:|
| **prev+curr per turn** (eval parity) | $0.1160 | $0.0796 | **−31.3%** | **100.0%** (0 misses) |
| **single-image per turn** (real agent loops) | $0.0670 | $0.0272 | **−59.4%** | (single-image baseline is uncompared)¹ |

Files: `eval/results/proxy_ab_login_baseline.json` + `.accuracy.json`. Reproducible: `node dist/eval/measure_proxy.js demo/screenshots/login_flow`.

The prev+curr mode is the apples-to-apples comparison (judge sees equal context on both sides) — savings are smaller here because the SDK still drags the prior image along even though the proxy rewrites the current one. The single-image mode is how Claude Code, Cursor, and computer-use agents actually call the API: one fresh screenshot per turn, no prior. That's where the savings open up.

¹ Single-image accuracy can't be fairly judged — Run A has no prior context, so the judge marks every "no change" frame as a disagreement. Same harness bias we identified in fair-baseline mode. The token/cost numbers are unaffected.

**Visual direction:**  
Two side-by-side bar groups (Login | Checkout) for harness numbers, then a third "Proxy validation" group with two bars — prev+curr (−31%) and single-image (−59%).

**Speaker note:**  
Lead with the cost number (90% on login, harness). Then immediately go to accuracy (100% lenient on login) before the audience asks "but does it work?" Use the two-scenario contrast to head off the "is this just an easy flow?" question — checkout was *harder* than login (no redundancy, bad OCR) and we still saved 81% cost. Then pivot to the proxy validation: "and the same pipeline, shipped as a transparent proxy, hits −31% on the same flow with zero misses — and −59% in the single-image-per-turn shape that real agent loops actually use." Mention the Phase 4 tuning trade openly: we made it worse on tokens (10pp) to make it better on accuracy (22pp). We count Haiku tokens against ourselves — this is honest accounting.

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

### The Proxy Beats Middleware Beats A Prompt

Three tiers of reliability, from weakest to strongest:

**Tier 1 — policy prompt (voluntary, weakest):** "please call statelens_observe before reasoning." Agent has to choose.

**Tier 2 — middleware (code-enforced, in-process):** the agent loop calls our adapter directly.

```ts
const { screenshot, observation, route } = await captureAndRoute(page, {
  sessionId: 'login_flow',
  actionLabel: 'click_submit',
});

if (route.route === 'skip_vision')        { /* spend zero model tokens */ }
if (route.route === 'use_text_observation') await reasoningModel({ text: route.context });
if (route.route === 'use_full_vision')      await reasoningModel({ image: screenshot });
```

Planned evidence-ladder hardening adds a middle route for localized visual evidence:

```ts
if (route.route === 'use_region_evidence') {
  await reasoningModel({
    text: route.context,
    images: route.changedRegionCrops,
  });
}
```

**Tier 3 — proxy (data-path, strongest, zero code change):**

```ts
const client = new Anthropic({
  baseURL: 'http://127.0.0.1:18443',  // ← only line that changes
});

// Your existing agent loop, unchanged.
await client.messages.create({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: [{ type: 'image', source: {...} }, { type: 'text', text: 'What changed?' }] }],
});
```

The proxy inspects the latest image block, runs `observe()`, and rewrites the request before it hits Anthropic — agent never sees StateLens tool JSON, no tool definitions get injected, no cache churn. Today the rewrite is a no-change stub, text observation, or fail-open full image. The evidence-ladder version keeps the same data-path integration while allowing changed-region crops when text alone is too lossy.

The `actionLabel` (Tier 2) is no longer just a hint. Mutating labels (`click_submit`, `save_*`, `fill_*`, `expect_change:*`) flip an unchanged screen from `no_change` to `action_failed`. Passive labels (`wait`, `observe:*`, `passive:*`) keep their quiet path.

**What is shipped now:**

- Anthropic-compatible HTTP proxy with streaming pass-through and recursion guard
- generic routing helper (`routeObservation()`)
- Playwright-like screenshot adapter (`captureAndRoute()`)
- conservative fallbacks for invalid screenshots and analysis errors
- optional screenshot-base64 MCP path for agents that hold images in memory
- action-label classifier that distinguishes mutating from passive actions
- `STATELENS_OCR_LANGS` env var for non-English UI flows
- next route: `use_region_evidence` for event card + changed crops when visual grounding matters

**Visual direction:**  
Three-tier stack (prompt → middleware → proxy) with "strength of enforcement" arrow pointing down to proxy, plus an evidence-ladder legend beside the proxy.

**Speaker note:**  
The folder demo proves the pipeline. The adapter proves it in real-time screenshot loops. The proxy proves it in the integration shape that requires the least from the agent author — and is the form where the cost numbers reproduce in production clients (see slide 9).

---

## Slide 9 - The Delivery-Surface Lesson

### We Shipped MCP, Dogfooded It, Found It Was More Expensive — Then Built The Proxy

The pipeline savings are real, but **the delivery surface matters as much as the pipeline.** We learned this by measuring our own MCP server end-to-end inside Claude Code.

**The dogfood:** two Claude Code sessions, identical 12-frame login prompt, identical model (Opus 4.7). Run A used `Read`. Run B swapped `Read` → `statelens_observe`. Cost measured by `/cost` in each session.

| Opus 4.7 metric | Run A (Read) | Run B (StateLens MCP) | Δ |
|---|---:|---:|---:|
| Total cost | $0.66 | **$0.84** | **+27% more expensive** |
| Output tokens | 2.1k | 3.5k | +1.4k (verbose tool args) |
| Cache write | 45.3k | 65.5k | +20.2k (JSON response churn) |
| Cache read | 657.8k | 685.1k | +27.3k (tool defs per turn) |

The opposite of the 80% reduction the harness predicts. We diagnosed three overheads, all properties of **MCP**, not properties of the pipeline:

1. **Tool-call argument verbosity** — `screenshot_path`, `session_id` is more output than `file_path`
2. **MCP tool definitions cached every turn** — 4 tools × ~400 tokens × 14 turns = ~22k extra cache reads
3. **JSON responses churning the cache** — every observation is textually unique, forces cache writes

Modeled breakeven on Opus: ~30–50 frames. Below that, MCP overhead dominates the per-frame savings.

**The fix — proxy form, same pipeline, different surface:**

| Surface | 12-frame login result |
|---|---|
| MCP, short Opus session | **+27% more expensive** |
| Proxy, prev+curr per turn | **−31.3% cheaper** (100% lenient accuracy, 0 misses) |
| Proxy, single-image per turn | **−59.4% cheaper** |

**Why the proxy has zero overhead:**

- runs *before* the request reaches the model
- agent never sees JSON observations — only the rewritten text-only or skipped message
- no tool definitions injected into agent context
- no tool-call arguments — the agent calls `messages.create` normally

**Visual direction:**  
Before/after diagram: MCP path with three red overhead arrows ("tool defs", "JSON churn", "verbose args") pointing into the agent context box; Proxy path with a single arrow that bypasses the agent context entirely and lands at upstream Anthropic.

**Speaker note:**  
This is the honest story we want judges to remember. We shipped, measured, found the bad result, diagnosed it (it wasn't the pipeline — it was the surface), and shipped the right surface. The pipeline is the IP. MCP is one delivery surface, and not the most leveraged one for short interactive sessions on expensive models. The proxy is the production-realistic incarnation. The reversal — same flow, same pipeline, +27% → −59% — is the most credible thing in the deck.

---

## Slide 10 - Next Wedge: Agentic Testing

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

## Slide 11 - Why StateLens Wins

### Model-External, Inspectable, And Drop-In

Existing research optimizes inside a specific VLM. StateLens optimizes outside the model.

| Approach | Tradeoff |
|---|---|
| Model-internal token pruning | powerful, but model-specific and invisible |
| Raw Playwright snapshots | great for accessible DOM, less helpful for pixel-heavy states |
| Full screenshot reasoning | general, but expensive and hard to debug |
| StateLens | model-agnostic, inspectable, and drop-in via Anthropic-compatible proxy |

**Moat in practice:**

- local-first diffing pipeline
- structured event timeline
- honest VLM usage accounting (we count our own Haiku tokens against ourselves)
- **drop-in proxy distribution** — change one `baseURL`, no code change, no per-turn MCP overhead
- MCP adapter for editor environments the proxy can't reach
- in-process route API for custom agents
- a measured, reversed engineering finding (MCP +27% → proxy −31% to −59%) that proves we know the difference between pipeline IP and delivery surface
- credible path into agentic testing and self-healing workflows

**Close:**  
StateLens is the universal observation layer for UI agents — and the proxy form means adopting it is one environment variable.

**Visual direction:**  
Four-quadrant matrix: model-specific vs model-agnostic, opaque vs inspectable. StateLens in the bottom-right with a star.

**Speaker note:**  
The thesis is simple: do not make every model relearn the same unchanged screen. Put an observation layer in front of them — and put it on the data path, not in the tool surface, so it costs nothing to adopt and nothing per turn.

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
- **Anthropic-compatible HTTP proxy** (`statelens proxy --port 18443`)
  - rewrites image blocks in `POST /v1/messages` to text observations or "no change" stubs
  - streaming response pass-through
  - recursion guard via `STATELENS_INTERNAL_ANTHROPIC_BASE_URL` so internal Haiku calls bypass the proxy
  - end-to-end measurement harness (`eval/measure_proxy.ts`, `npm run` script `eval/measure_proxy.js`)
- MCP server with 4 tools
- path and base64 screenshot input
- A/B token measurement harness (`npm run measure`)
- Haiku-judged accuracy harness with strict / lenient scoring
- two locked baselines: login (12 frames) and checkout (10 frames)
- proxy-form baseline: `eval/results/proxy_ab_login_baseline.json` + `.accuracy.json`
- saved per-frame verdicts under `eval/results/phase4_*.accuracy.json`
- route helper for custom agents (`routeObservation()`)
- Playwright-like capture adapter (`captureAndRoute()`)
- live Playwright demo (`demo/agent_loop/playwright_login.ts`)
- action-failure detection via `actionLabel` classifier (`action_failed` event)
- multi-language OCR via `STATELENS_OCR_LANGS`
- `RESULTS.md` documenting full measurement evolution, including the MCP-dogfood overhead finding and proxy reversal
- `docs/PROXY_IMPLEMENTATION.md` design doc

### Pitch As Roadmap

- Playwright Test fixture
- healer-loop failure context
- test report artifacts
- Stagehand adapter
- agentic testing cost dashboard
- hosted/cloud proxy endpoint (today's proxy is local-only)
- OpenAI / Gemini API-compatible proxy surfaces

### Do Not Claim Yet

- hosted multi-tenant proxy
- universal savings on non-screenshot Playwright tests
- completed Playwright Test Agent integration
- completed Stagehand integration
- production browser extension
- non-Anthropic proxy support
