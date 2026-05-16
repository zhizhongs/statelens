# StateLens

> Open-source MCP server for UI agent observation compression. **Measured 70-82% input-token reduction and 81-90% cost reduction on real Anthropic API calls, with 78-100% event-capture accuracy** across two screenshot scenarios. See [`RESULTS.md`](./RESULTS.md) for the full numbers.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-54%20passing-brightgreen.svg)](./tests)
[![MCP](https://img.shields.io/badge/protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)

## The problem

Computer-use and UI-testing agents call a vision model after every action. Most consecutive screenshots are visually identical or only differ in trivial ways. The agent still pays full-resolution image tokens to rediscover that nothing meaningful changed. Microsoft Research measured 36-56% of consecutive frames as pixel-identical in real agent traces.

Existing fixes (ReVision, ShowUI, etc.) are model-internal — they require fine-tuning a specific VLM. There's no install path for end users, no observability into what was kept or dropped, and a different team has to re-implement the optimization for every model.

## What StateLens does

StateLens sits between the screenshot stream and the reasoning model as an **external middleware**. For each screenshot it:

1. **Filters identical frames** with a perceptual hash + pixelmatch gate (zero AI calls, <50ms).
2. **Localizes changes** with pixel diff + connected-component bounding boxes.
3. **Extracts text changes** by OCR'ing only the changed regions (not the whole screen).
4. **Scores importance** with a rule-based scorer that gates a tiny Haiku VLM call.
5. **Emits a semantic event** — structured JSON with `event_summary`, `text_diff`, `changed_regions` — that an agent can reason over without ever seeing the image bytes.

Result: the same screenshot-heavy task that costs $0.12 in raw Sonnet calls costs $0.01 routed through StateLens. The agent gets a readable timeline of what actually happened, not 12 base64 blobs.

## How users plug it in

There are two integration surfaces. Pick based on what you control.

### Path A — MCP server (for editors and closed clients)

For developers using **Cursor**, **Claude Code**, **Claude Desktop**, or any MCP-compatible client. Zero code changes: install the server, add it to your MCP config, give the agent a one-line policy prompt.

```bash
npm install -g statelens
```

Add to your MCP config (`~/.cursor/mcp.json`, `~/.claude/mcp.json`, or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "statelens": {
      "command": "statelens",
      "args": ["serve"]
    }
  }
}
```

Then add this policy prompt to the agent's system / project prompt so it actually uses the tools:

```text
Before reasoning over any screenshot, call statelens_observe with the current
screenshot and session_id.

If changed=false, do not send the screenshot to a vision model. Continue from
the previous state unless the task explicitly requires visual inspection.

If keyframe=true and vlm_called=false, use event_summary, text_diff, and
changed_regions as the primary observation.

Call statelens_timeline before summarizing the session or reporting what
happened.
```

**Caveat:** MCP tool selection is voluntary. Closed clients can ignore a tool on any given turn. If you need guaranteed interception, use Path B.

### Path B — In-process adapter (for live UI agents you control)

For agents whose runtime you control: **Playwright/Puppeteer test runners with an LLM driving them, custom Anthropic SDK loops, browser/desktop automation, eval harnesses**. The decision lives in your code — no prompt-following required, no closed-client cooperation needed.

This isn't just "feed StateLens prerecorded screenshots." It's a real-time middleware that sits inside a live UI automation loop: every time your agent takes an action and the page changes, StateLens decides whether the LLM needs to see anything.

```ts
import { captureAndRoute } from 'statelens/dist/src/adapters/playwright.js';

// Inside your agent's action loop:
await page.click('#submit');
const { observation, route, screenshot } = await captureAndRoute(page, {
  sessionId: 'login_flow',
  actionLabel: 'click_submit',   // for failure detection (see below)
});

switch (route.route) {
  case 'skip_vision':
    // Nothing meaningful changed — keep going with the prior state. Zero LLM tokens.
    break;
  case 'use_text_observation':
    // Send the structured event to your reasoning model. Tiny prompt, cheap call.
    await reasoningModel({ text: route.context });
    break;
  case 'use_full_vision':
    // Visual-only keyframe — pass the actual screenshot through.
    await reasoningModel({ image: screenshot });
    break;
}
```

The adapter accepts any object with a `screenshot(): Promise<Buffer>` method — Playwright, Puppeteer, Detox, Appium, or a hand-rolled driver. A standalone `routeObservation()` helper is also exported if you already have your own capture pipeline and just want the routing decision.

#### Live working demo

[`demo/agent_loop/playwright_login.ts`](./demo/agent_loop/playwright_login.ts) is a complete reference: launches headless Chromium, navigates to a synthetic login page, performs real fill/click actions, and routes every observation through StateLens.

```bash
npm install --save-dev playwright
npx playwright install chromium
npm run build
node dist/demo/agent_loop/playwright_login.js
```

Sample output:

```
[TEXT  ] navigate_login         event=session_start       score=1.00
           context:
             First screenshot in session
[SKIP  ] idle_recapture         event=no_change           score=0.00
           reason: visual gate filtered (changed: false)
[TEXT  ] type_email             event=text_appeared       score=0.40
           context:
             Text appeared: "user@example.com"
[TEXT  ] type_password          event=text_appeared       score=0.40
           context:
             Text appeared: "••••••"
[VISION] submit_bad_password    event=error_appeared      score=0.80
           reason: high importance + visual change requires VLM
    [mock VLM] would send 12873 byte screenshot with prompt: "Red error banner appeared: Invalid password"

Mock VLM calls actually made: 1
```

5 agent actions → 1 VLM call. That's the value StateLens adds to a live workflow.

## MCP tools

| Tool | What it does |
|---|---|
| `statelens_observe` | Analyze a screenshot for changes. Returns `{changed, keyframe, event_summary, text_diff, changed_regions, vlm_called}`. Accepts `screenshot_path` (file) or `screenshot_base64` (in-memory). |
| `statelens_timeline` | Returns the full session event log with `vlm_calls_made` / `vlm_calls_saved`. |
| `statelens_compare` | Stateless diff between two screenshots. No session required. |
| `statelens_reset` | Clear a session's stored state. |

## Failure detection

StateLens can flag when an agent action that should have produced a UI change didn't — useful for catching stuck buttons, broken flows, and silent failures in long automation runs.

Pass an `action_label` to `statelens_observe`:

```ts
await observe(screenshot, sessionId, 'click_submit');
```

The pipeline classifies labels as `mutating` (`click`, `submit`, `login`, `checkout`, `delete`, ...), `passive` (`hover`, `scroll`, `wait`, ...), or unknown. When a mutating action produces no visual change, the observation is tagged with an `action_failed` event type instead of `no_change`. See [`docs/PIPELINE_PHASE4_IMPLEMENTATION.md`](./docs/PIPELINE_PHASE4_IMPLEMENTATION.md) for the classifier rules.

## Headline measurements

Real Anthropic API token counts, two screenshot scenarios, baseline = raw screenshots through Sonnet with a fair "what changed" prompt (prev + curr image per frame):

| Scenario | Frames | Token reduction | Cost reduction | Accuracy (lenient) | Accuracy (strict) |
|---|---|---|---|---|---|
| **Login** (GitHub sign-in → 2FA → dashboard) | 12 | **81.9%** | **90.1%** | **100.0%** | 81.8% |
| **Checkout** (Zara cart → shipping → payment) | 10 | **69.9%** | **81.2%** | **77.8%** | 33.3% |

Accuracy is judged by Claude Haiku against the raw-image baseline (does StateLens's compressed signal describe the same UI event?). `skipped` frames count as agreement; first frame of each session is excluded. Full per-frame verdicts under [`eval/results/phase4_*.accuracy.json`](./eval/results/).

Token counts come directly from `response.usage.input_tokens` in the Anthropic API responses. **The harness includes honest accounting for Haiku tokens consumed inside StateLens** — Run B's reported total includes Haiku, so the savings claim is not a "shift to a cheaper model" trick.

Reproduce locally:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run measure                                       # login flow
npm run measure -- demo/screenshots/checkout_flow     # checkout flow
node dist/eval/accuracy_check.js eval/results/phase4_login_tuned.json
```

### What the harness output looks like

The harness sends the same 12-frame login sequence to Claude Sonnet twice — once raw (Run A) and once routed through StateLens (Run B) — and prints the actual API token counts.

**Login flow (12 frames):**

```
Task: 12-frame login flow analysis
Model: claude-sonnet-4-6 (StateLens internal: claude-haiku-4-5)

Run A (baseline, prev+curr image to Sonnet per frame, asks "what changed"):
  API calls:        12
  Input tokens:     36,255
  Cost:             $0.1162

Run B (StateLens compression):
  Sonnet calls:     2   (text-only summaries, ~25 input tokens each)
  Haiku calls:      5   (visual-only keyframes, downscaled to 768px)
  Frames skipped:   5   (filtered by visual gate, zero AI calls)
  Total input:      6,562 tokens   (49 Sonnet + 6,513 Haiku)
  Cost:             $0.0115

Savings:
  Input tokens:        81.9%
  Cost:                90.1%
  Sonnet image tokens: 100%  (12 image calls → 0)
```

**Checkout flow (10 frames, form-heavy, zero gate-filterable frames):**

```
Task: 10-frame checkout flow analysis
Model: claude-sonnet-4-6 (StateLens internal: claude-haiku-4-5)

Run A (baseline, prev+curr image to Sonnet per frame):
  API calls:        10
  Input tokens:     29,951
  Cost:             $0.0988

Run B (StateLens compression):
  Sonnet calls:     4   (text-only summaries)
  Haiku calls:      6   (visual-only keyframes, Phase 4 tuning pushed
                         form-fill frames here for accuracy)
  Frames skipped:   0   (no two consecutive frames are pixel-redundant)
  Total input:      9,025 tokens   (128 Sonnet + 8,897 Haiku)
  Cost:             $0.0186

Savings:
  Input tokens:        69.9%
  Cost:                81.2%
```

**Reading the numbers:** on login, the visual gate eliminates 42% of frames entirely. Of the remaining keyframes, OCR-driven text diffs answer most with tiny text-only Sonnet calls; the rest go to Haiku on 768px-downscaled images (Anthropic prices images by tile count, which scales with resolution). On checkout, the visual gate doesn't help because every frame differs — savings come from routing form-fills and small transitions through cheap Haiku calls instead of full-resolution Sonnet image tokens.

Full methodology and evolution: [`RESULTS.md`](./RESULTS.md).

## Architecture

```
Screenshot Input
       │
       ▼
[Stage 1] Cheap Visual Gate          ──  hash + pixelmatch, <5ms, zero AI
       │
       │  (if filtered: return changed: false, 0 tokens)
       ▼
[Stage 2] Spatial Diff Localization  ──  pixel diff + bounding boxes, <10ms
       │
       ▼
[Stage 3] OCR Text Diff              ──  tesseract.js on cropped regions only, <200ms
       │
       ▼
[Stage 4] Importance Scorer          ──  rule-based + OCR-reliability check
       │
       ▼
[Stage 5] Selective VLM Explainer    ──  Haiku, downscaled images, only for visual-only keyframes
       │
       ▼
[Stage 6] Timeline Assembly          ──  session event log + cost metrics
       │
       ▼
Structured Observation Response
```

See [`DESIGN.md`](./DESIGN.md) Section 4 for per-stage implementation details.

## Project layout

```
src/pipeline/        Pipeline stages (visual gate, spatial diff, OCR, scorer, VLM, timeline)
src/server.ts        MCP server (stdio transport, 4 tools)
src/adapters/        In-process adapters (Playwright, generic route helper)
src/index.ts         CLI: serve | run | measure
eval/                A/B token measurement harness + Haiku accuracy judge
demo/                Prerecorded screenshot sequences (login, checkout)
tests/               Vitest unit tests
docs/                Design docs and implementation notes
```

## Development

```bash
git clone https://github.com/zhizhongs/statelens.git
cd statelens
npm install
npm run build       # production build to ./dist
npm test            # vitest run (54 tests across pipeline + adapters)
npm run dev         # tsc --watch
```

`ANTHROPIC_API_KEY` is required to run the VLM stage and the measurement harness. Put it in `.env` (gitignored).

## License

[MIT](./LICENSE)
