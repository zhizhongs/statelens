# StateLens Pitch Deck

Status: pitch content draft  
Audience: hackathon judges, developer-tool investors, AI tooling partners  
Goal: explain what is built now, prove the savings, and show agentic testing as the next wedge

## Slide 1 - Title

### StateLens

**The observation compression layer for UI agents.**

Computer-use agents waste money re-reading screenshots where nothing meaningful changed. StateLens turns screenshot streams into semantic state changes before the expensive model sees them.

**Proof point:** 69% cost reduction on a 12-frame login flow, measured with real Anthropic API usage.

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

### 69% Cost Reduction With Honest Accounting

Measured on a 12-frame login-flow analysis using real Anthropic API token counts.

| Metric | Baseline raw images | StateLens compression |
|---|---:|---:|
| API path | 12 Sonnet image calls | 3 Sonnet text calls + internal Haiku |
| Input tokens | 19,008 | 14,249 |
| Cost | $0.0640 | $0.0196 |
| Wall time | 33.2s | 30.5s |
| Frames skipped | 0 | 5 |

**Savings:**

- 69.4% cost reduction
- 25.0% input-token reduction
- 99.6% reduction in Sonnet input tokens
- 5 of 12 frames filtered with zero model calls

**Visual direction:**  
Side-by-side bar chart: cost, Sonnet input tokens, frames skipped.

**Speaker note:**  
We count the Haiku tokens StateLens uses internally. This is not hiding model cost. It is honest accounting.

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

**What is shipped now:**

- generic routing helper
- Playwright-like screenshot adapter
- conservative fallbacks for invalid screenshots and analysis errors
- optional screenshot-base64 MCP path for agents that hold images in memory

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

- Stage 1 visual gate
- Stage 2 spatial diff localization
- Stage 3 OCR text diff on changed crops
- Stage 4 importance scorer
- Stage 5 selective VLM explanation
- Stage 6 timeline assembly
- VLM cumulative usage tracking
- Phase 3 reliability fallbacks
- MCP server with 4 tools
- path and base64 screenshot input
- A/B token measurement harness
- saved Phase 3 baseline result
- route helper for custom agents
- Playwright-like capture adapter
- live demo script

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
