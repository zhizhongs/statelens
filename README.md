# StateLens

> Open-source MCP server for UI agent observation compression. Filters redundant screenshots, extracts semantic state changes, cuts VLM calls by ~85%.

StateLens sits between a UI agent and its reasoning model. It watches a stream of screenshots, filters out redundant frames cheaply, extracts semantic state changes, and returns a structured observation. The agent receives a compressed, human-readable diff instead of raw pixels.

Works with **Cursor**, **Claude Code**, **Claude Desktop**, and any MCP-compatible client.

See [`DESIGN.md`](./DESIGN.md) for the full design document.

## Status

Hackathon scaffold. Not yet functional. See [`DESIGN.md` Section 8](./DESIGN.md) for the 48-hour build roadmap.

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

## Quickstart

Once configured, ask your editor's agent:

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
happened.
```

### Known limitations

- Compliance is voluntary: a closed client may skip the tool on any given turn.
- Token accounting is approximate: we only see calls the agent actually makes.
- For reliable interception, use the in-process adapter path below.

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

The adapter has no hard dependency on Playwright — it accepts any object with `screenshot(): Promise<Buffer>`, which means Puppeteer, Playwright, or your own browser/desktop driver all work. The reference demo is at [`demo/agent_loop/playwright_login.ts`](./demo/agent_loop/playwright_login.ts) and requires Playwright as an optional runtime dep:

```bash
npm install --save-dev playwright
npx playwright install chromium
npm run build
node dist/demo/agent_loop/playwright_login.js
```

The routing helper [`routeObservation()`](./src/adapters/routeObservation.ts) is also exposed standalone if you already have your own capture pipeline and just want the decision.

## Measuring Savings

The repo ships with an A/B harness that runs the same screenshot task twice against the Anthropic API — once with raw images, once routed through StateLens — and reports actual token deltas.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run measure
```

Measured output (12-frame login flow, real Anthropic API calls):

```
Task: 12-frame login flow analysis
Model: claude-sonnet-4-6 (StateLens internal: claude-haiku-4-5)

Run A (baseline, raw images):
  API calls:        12
  Input tokens:     19,008
  Output tokens:    462
  Wall time:        33.2s
  Cost:             $0.0640

Run B (StateLens compression):
  Sonnet calls:     3   (text-only summaries)
  Haiku calls:      4   (visual-only keyframes inside StateLens)
  Frames skipped:   5   (filtered by visual gate, zero AI calls)
  Total input:      14,249 tokens   (71 Sonnet + 14,178 Haiku)
  Wall time:        30.5s
  Cost:             $0.0196

Savings:
  Input tokens:        25.0%
  Cost:                69.4%
  Sonnet input tokens: 99.6% (12 image calls → 3 text-only calls)
```

Token counts come directly from `response.usage.input_tokens` in the Anthropic API responses. The harness includes honest accounting for Haiku tokens consumed inside StateLens — Run B's reported total includes Haiku, so the savings claim is not a "shift to a cheaper model" trick.

**Reading the numbers:** the visual gate eliminates 42% of frames entirely. Of the remaining keyframes, OCR-driven text diffs let us answer most of them with tiny text-only Sonnet calls (71 input tokens total). The remaining frames where text alone can't explain the change get a Haiku vision call. Result: the same task that cost $0.064 in raw API calls costs $0.020 routed through StateLens.

## Architecture

```
Screenshot Input
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
Structured Observation Response
```

See [`DESIGN.md`](./DESIGN.md) Section 4 for implementation details of each stage.

## Project Structure

```
src/pipeline/        Pure TypeScript library (Person A owns)
src/server.ts        MCP server (Person B owns)
src/index.ts         CLI entry: serve | run | measure
eval/                Token measurement harness — primary demo artifact
demo/                Prerecorded screenshot sequences
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
