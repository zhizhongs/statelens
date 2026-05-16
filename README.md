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
| `statelens_observe` | Analyze a screenshot for changes since the last observation. Returns structured diff. |
| `statelens_timeline` | Get the semantic timeline of UI state changes for a session, with cost metrics. |
| `statelens_compare` | Compare two screenshots directly. No session required. |
| `statelens_reset` | Reset a session, clearing stored state. |

## Measuring Savings

The repo ships with an A/B harness that runs the same screenshot task twice against the Anthropic API — once with raw images, once routed through StateLens — and reports actual token deltas.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run measure
```

Output (example):

```
Task: 14-frame login flow analysis
Model: claude-sonnet-4-6

Run A (baseline, raw images):
  Input tokens: 16,847   Cost: $0.0589   Time: 28.4s

Run B (StateLens compression):
  Input tokens: 3,720    Cost: $0.0093   Time: 2.6s

Savings: 77.9% tokens, 84.2% cost, 90.8% latency
```

Token counts come directly from `response.usage.input_tokens` in the Anthropic API responses. The harness includes honest accounting for Haiku tokens consumed inside StateLens.

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
