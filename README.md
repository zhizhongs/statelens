# StateLens

> Screenshot gateway for computer-use agents. StateLens ships today as an MCP server and in-process routing library, with a proxy/gateway path planned next. **Measured: 70-82% input-token reduction, 81-90% cost reduction on real Anthropic API calls, with 78-100% event-capture accuracy** across two scenarios. See [`RESULTS.md`](./RESULTS.md) for the full numbers.

StateLens sits between a UI agent and its reasoning model. It watches a stream of screenshots, filters out redundant frames cheaply, extracts semantic state changes, and returns a structured observation. The agent receives a compressed, human-readable diff instead of raw pixels.

Today it works with **Cursor**, **Claude Code**, **Claude Desktop**, any MCP-compatible client, and custom agent loops that can call the TypeScript routing helper. The next delivery surface is a local SDK/proxy gateway for agents that send screenshots through configurable model SDKs.

See [`DESIGN.md`](./DESIGN.md) for the full design document.

## Status

Working MCP server, pipeline, Playwright-shaped adapter, and measurement harness. The proxy/gateway integration described below is intentionally a design target, not a shipped command yet. See [`DESIGN.md`](./DESIGN.md) for the current architecture and gateway roadmap.

## For the build team

Two-person split with phased merge checkpoints:
- [`docs/ROLE_PIPELINE.md`](./docs/ROLE_PIPELINE.md) — Person A (pipeline library)
- [`docs/ROLE_DISTRIBUTION.md`](./docs/ROLE_DISTRIBUTION.md) — Person B (MCP server, demo, measurement harness)
- [`docs/README.md`](./docs/README.md) — phase timeline summary

## Install

```bash
npm install -g statelens
```

Or build from source:

```bash
git clone https://github.com/zhizhongs/statelens.git
cd statelens
npm install
npm run build
npm link
```

## Configure

MCP remains a first-class integration. Do not remove or bypass it when adding proxy support; the gateway is an additional wrapper around the same pipeline.

### Cursor

Add to `~/.cursor/mcp.json`:

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

### Claude Code

Add to `~/.claude/mcp.json` (same shape as above).

### Claude Desktop

Add to `claude_desktop_config.json` (same shape as above).

## Integration Surfaces

StateLens has one core pipeline and multiple delivery surfaces:

| Surface | Status | Best for |
|---|---|---|
| MCP server (`statelens serve`) | Built | Cursor, Claude Code, Claude Desktop, and agents that can choose to call tools |
| In-process routing helper | Built | Custom Playwright/Puppeteer/browser-use style loops where you control screenshot capture |
| SDK middleware | Planned | Apps that instantiate the Anthropic/OpenAI SDK in code and can wrap the client |
| Local API proxy/gateway | Planned | SDK-based agents or binaries that support `baseURL` / endpoint overrides |

The MCP server asks the agent to call `statelens_observe`. The proxy/gateway form sits in the model-request path and can gate screenshots even when the agent loop itself was not written to call an MCP tool.

Planned proxy shape:

```bash
statelens proxy --provider anthropic --port 8443
export ANTHROPIC_BASE_URL=http://localhost:8443
```

The gateway would receive Anthropic-compatible `POST /v1/messages` requests, detect screenshot image blocks, run the existing StateLens pipeline, and then either forward the request unchanged, strip image blocks and inject a text observation, or conservatively forward unchanged on analysis errors. Hard short-circuit responses are an opt-in mode, not the default.

See [`docs/PROXY_IMPLEMENTATION.md`](./docs/PROXY_IMPLEMENTATION.md) for the implementation plan: file layout, request rewriting rules, session handling, upstream forwarding, tests, and rollout milestones.

## Quickstart

For the live demo path, run the computer-use-style agent loop. It drives a
browser, captures fresh screenshots after each action, routes them through
StateLens, and prints the saved-token estimate at the end.

```bash
npm run build
npm run demo:computer-use
```

The demo requires Playwright as an optional runtime dependency:

```bash
npm install --save-dev playwright
npx playwright install chromium
```

Folder replay is still available as a fallback or regression check:

```
Use statelens_observe to walk through the screenshots in ./demo/screenshots/login_flow/
and tell me what happened.
```

The agent calls `statelens_observe` for each frame. StateLens filters redundant frames, extracts text diffs, and returns structured events. Only frames with meaningful visual-only changes trigger an internal VLM call.

## MCP Tools

| Tool | Description |
|---|---|
| `statelens_observe` | Analyze a screenshot for changes since the last observation. Returns structured diff. Accepts either `screenshot_path` (local file) or `screenshot_base64` (in-memory image). |
| `statelens_timeline` | Get the semantic timeline of UI state changes for a session, with cost metrics. |
| `statelens_compare` | Compare two screenshots directly. No session required. |
| `statelens_reset` | Reset a session, clearing stored state. |

`statelens_observe` requires exactly one of `screenshot_path` or `screenshot_base64`. Pass `screenshot_base64` when the agent holds the screenshot in memory (a `data:` URL prefix is tolerated). `mime_type` is accepted but informational — sharp auto-detects the actual format.

## Closed MCP Clients (Claude Code, Cursor, Claude Desktop)

These clients control their own screenshot loop, so we cannot intercept it from code. The integration is best-effort: install the MCP server, then attach a policy prompt that tells the agent when to call StateLens.

### Policy prompt

Paste this into the agent's system / project prompt:

```text
Before reasoning over any screenshot, call statelens_observe with the current
screenshot and session_id.

If changed=false, do not send the screenshot to a vision model. Continue from
the previous state unless the task explicitly requires visual inspection.

If keyframe=true and vlm_called=false, use event_summary, text_diff, and
changed_regions as the primary observation.

If event_type is invalid_screenshot or analysis_error, fall back to normal
screenshot reasoning.

Call statelens_timeline before summarizing the session or reporting what
happened. Include total_screenshots, vlm_calls_saved, reduction_pct, and
estimated_tokens_saved in the final answer.
```

### Known limitations

- Compliance is voluntary: a closed client may skip the tool on any given turn.
- Token accounting is approximate: we only see calls the agent actually makes.
- For reliable interception today, use the in-process adapter path below. For SDK-based agents that expose a base URL override, use the planned proxy/gateway path once it ships.

## In-Process Agent Integration (Custom Agents, Demos, Eval Harnesses)

For agents whose runtime you control, StateLens ships a routing helper and a Playwright reference adapter that put the decision in code rather than in a prompt.

```ts
import { captureAndRoute } from 'statelens/dist/src/adapters/playwright.js';

const { observation, route, screenshot } = await captureAndRoute(page, {
  sessionId: 'login_flow',
  actionLabel: 'click_submit',
});

switch (route.route) {
  case 'skip_vision':
    // No meaningful change — keep going with the prior state.
    break;
  case 'use_text_observation':
    await reasoningModel({ text: route.context });
    break;
  case 'use_full_vision':
    await reasoningModel({ image: screenshot });
    break;
}
```

The adapter has no hard dependency on Playwright — it accepts any object with `screenshot(): Promise<Buffer>`, which means Puppeteer, Playwright, or your own browser/desktop driver all work. The reference live computer-use demo is at [`demo/agent_loop/playwright_login.ts`](./demo/agent_loop/playwright_login.ts) and requires Playwright as an optional runtime dep:

```bash
npm install --save-dev playwright
npx playwright install chromium
npm run build
npm run demo:computer-use
```

At the end it reports both route-level downstream savings (full screenshot calls avoided and estimated downstream input tokens saved) and the StateLens timeline accounting (`vlm_calls_saved`, `reduction_pct`, `estimated_tokens_saved`).

The routing helper [`routeObservation()`](./src/adapters/routeObservation.ts) is also exposed standalone if you already have your own capture pipeline and just want the decision. [`estimateRouteSavings()`](./src/adapters/routeObservation.ts) turns a list of route decisions into the same saved-token summary used by the live demo.

To run the full `RESULTS.md`-style evaluation from a fresh live capture instead of the checked-in screenshot folders:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run build
npm run eval:live
```

That command captures the login flow on the fly, runs the same A/B efficiency harness as `npm run measure`, then runs the Haiku accuracy judge. It saves `eval/results/live_login_*.json` and `eval/results/live_login_*.accuracy.json` with the token, cost, latency, strict accuracy, and lenient accuracy fields used in [`RESULTS.md`](./RESULTS.md). Use `npm run eval:live -- --no-accuracy` when you only want the efficiency run.

## Measuring Savings

The repo ships with an A/B harness that runs the same screenshot task twice against the Anthropic API — once with raw images, once routed through StateLens — and reports actual token deltas.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run measure
```

### Headline results

Measured on two scenarios, real Anthropic API token counts, baseline = raw screenshots through Sonnet with a fair "what changed" prompt (prev + curr image to Sonnet per frame):

| Scenario | Frames | Token reduction | Cost reduction | Accuracy (lenient) | Accuracy (strict) |
|---|---|---|---|---|---|
| **Login** (GitHub sign-in → 2FA → dashboard) | 12 | **81.9%** | **90.1%** | **100.0%** | 81.8% |
| **Checkout** (Zara cart → shipping → payment) | 10 | **69.9%** | **81.2%** | **77.8%** | 33.3% |

Accuracy is judged by Claude Haiku against the raw-image baseline (does StateLens's compressed signal describe the same UI event?). `skipped` frames count as agreement; first frame of each session is excluded (no prior to compare against). Full per-frame verdicts under `eval/results/phase4_*.accuracy.json`.

**Headline numbers come from `eval/results/phase4_login_tuned.json` and `eval/results/phase4_checkout_tuned.json`.** Full evolution and methodology in [`RESULTS.md`](./RESULTS.md).

### Login example output (12-frame run, post-Phase-4 tuning)

```
Task: 12-frame login flow analysis
Model: claude-sonnet-4-6 (StateLens internal: claude-haiku-4-5)

Run A (baseline, raw images, prev+curr to Sonnet per frame):
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

Token counts come directly from `response.usage.input_tokens` in the Anthropic API responses. The harness includes honest accounting for Haiku tokens consumed inside StateLens — Run B's reported total includes Haiku, so the savings claim is not a "shift to a cheaper model" trick.

**Reading the numbers:** the visual gate eliminates 42% of frames entirely. Of the remaining keyframes, OCR-driven text diffs let us answer some of them with tiny text-only Sonnet calls. The rest get a Haiku vision call — and those images are downscaled to 768px before encoding (Anthropic prices images by tile count, which scales with resolution). Result: the same task that cost $0.116 in raw API calls costs $0.012 routed through StateLens.

## Architecture

```
Input Surface
  - MCP tool call
  - In-process adapter
  - Planned SDK/proxy gateway
       |
       v
[Stage 1] Cheap Visual Gate          <-- hash + pixelmatch, <5ms
       |
       | (if similar: return changed: false)
       v
[Stage 2] Spatial Diff Localization  <-- pixel diff + bounding boxes, <10ms
       |
       v
[Stage 3] OCR Text Diff             <-- tesseract.js on cropped regions, <200ms
       |
       v
[Stage 4] Importance Scorer          <-- rule-based scoring
       |
       v
[Stage 5] Selective VLM Explainer    <-- Haiku, only for visual-only keyframes
       |
       v
[Stage 6] Timeline Assembly          <-- session event log
       |
       v
Structured observation or rewritten model request
```

See [`DESIGN.md`](./DESIGN.md) Section 4 for implementation details of each stage and Section 5.5 for the planned local gateway.

## Project Structure

```
src/pipeline/        Pure TypeScript library (Person A owns)
src/server.ts        MCP server (Person B owns)
src/index.ts         CLI entry: serve | run | measure | proxy (planned)
src/adapters/        Built in-process routing helpers
src/gateway/         Planned request rewriting layer
src/middleware/      Planned SDK wrappers
src/proxy/           Planned local API gateways
eval/                Token measurement harness — primary demo artifact
demo/                Live computer-use demo + prerecorded screenshot sequences
tests/               Vitest unit tests
```

## Development

```bash
npm install
npm run dev          # tsc --watch
npm test             # vitest run
npm run build        # production build to ./dist
```

## License

[MIT](./LICENSE)
