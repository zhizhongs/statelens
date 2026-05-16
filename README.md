# StateLens

> Screenshot gateway for computer-use agents. StateLens ships as an MCP server, in-process routing library, and local Anthropic-compatible proxy. **Measured: 70-82% input-token reduction and 81-90% cost reduction** on real Anthropic API calls across two UI flows.

StateLens sits between a UI agent and its reasoning model. It watches screenshot streams, filters redundant frames, extracts semantic state changes, and replaces expensive image input with compact text observations when it is safe to do so.

Use it when you are building or running screenshot-heavy browser/computer-use agents and want to stop paying for frames that did not meaningfully change.

## Install

```bash
npm install -g statelens-sdk
```

Or from source:

```bash
git clone https://github.com/zhizhongs/statelens.git
cd statelens
npm install
npm run build
npm link
```

## Use The Proxy

Use the Anthropic-compatible proxy when your agent or SDK can set `ANTHROPIC_BASE_URL`. This is the most transparent integration because StateLens sits directly in the model-request path.

Start StateLens:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
statelens proxy --provider anthropic --port 8443
```

Point your Anthropic SDK-based agent at it:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8443
```

Then run your existing agent normally.

Health check:

```bash
curl http://127.0.0.1:8443/health
```

Optional session controls:

```bash
export STATELENS_SESSION_ID=my-run
# or send x-statelens-session-id: my-run
```

Debug endpoints:

```bash
curl http://127.0.0.1:8443/sessions/my-run/timeline
curl -X POST http://127.0.0.1:8443/sessions/my-run/reset
```

Proxy behavior:

- Targets Anthropic `/v1/messages`.
- Detects base64 screenshot image blocks in the latest user message.
- Forwards first frames, analysis errors, and ambiguous requests unchanged.
- Replaces safe-to-compress screenshots with StateLens text observations.
- Does not MITM traffic or require a custom CA certificate.
- Does not synthesize provider responses by default.

## Use MCP

Use MCP when your client can discover tools and you want StateLens observations available inside the agent. MCP remains a first-class integration; the proxy is an additional wrapper around the same pipeline.

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

Add to `~/.claude/mcp.json` using the same shape.

### Claude Desktop

Add to `claude_desktop_config.json` using the same shape.

MCP caveat: tool use is voluntary. For transparent cost reduction, prefer the proxy when your SDK supports a base URL override.

## Use In Process

Use the TypeScript adapter when you control the agent loop.

```ts
import { captureAndRoute } from 'statelens-sdk';

const { observation, route, screenshot } = await captureAndRoute(page, {
  sessionId: 'login_flow',
  actionLabel: 'click_submit',
});

switch (route.route) {
  case 'skip_vision':
    break;
  case 'use_text_observation':
    await reasoningModel({ text: route.context });
    break;
  case 'use_full_vision':
    await reasoningModel({ image: screenshot });
    break;
}
```

The adapter accepts any object with `screenshot(): Promise<Buffer>`, including Playwright, Puppeteer, or your own browser/desktop driver.

The lower-level routing helper is also available:

```ts
import { observe, routeObservation } from 'statelens-sdk';

const observation = await observe(screenshotBuffer, 'session-id', 'click_submit');
const route = routeObservation(observation);
```

## Integration Surfaces

| Surface | Status | Best for |
|---|---|---|
| Local API proxy (`statelens proxy`) | Built for Anthropic | SDK-based agents or binaries that support `baseURL` / endpoint overrides |
| MCP server (`statelens serve`) | Built | Cursor, Claude Code, Claude Desktop, and agents that can choose to call tools |
| In-process routing helper | Built | Custom Playwright/Puppeteer/browser-use style loops |
| SDK middleware | Planned | Apps that instantiate the Anthropic/OpenAI SDK in code and can wrap the client |

All surfaces use the same pipeline:

```text
screenshot
  -> visual gate
  -> spatial diff
  -> OCR diff
  -> importance score
  -> optional small VLM explanation
  -> text observation, full-vision fallback, or no-change route
```

## Results

All numbers are measured with real Anthropic API token counts (no estimates). The harness includes internal Haiku usage, so savings are not hidden by shifting work to a cheaper model.

### Pipeline measurements (in-process eval, baseline = prev+curr screenshots to Sonnet)

| Scenario | Frames | Token reduction | Cost reduction | Accuracy (lenient) |
|---|---:|---:|---:|---:|
| Login flow | 12 | 81.9% | 90.1% | 100.0% |
| Checkout flow | 10 | 69.9% | 81.2% | 77.8% |

### End-to-end proxy A/B (login flow, 12 frames, real HTTP round-trip through `statelens proxy`)

Same code on both sides — the only difference between Run A and Run B is the `baseURL` of the Anthropic client.

| Agent pattern | Token reduction | Cost reduction | Accuracy (strict) | Accuracy (lenient) |
|---|---:|---:|---:|---:|
| Single-image-per-turn (Claude Code / Cursor / computer-use style) | **46.7%** | **59.4%** | — | — |
| Prev+curr per turn (change-detection agents) | **24.2%** | **31.3%** | 75.0% | **100.0% (zero misses)** |

The proxy form preserves the same observation quality as the in-process pipeline (visual-gate filters count as match-by-construction, same as the in-process eval). The single-image-per-turn pattern produces larger savings because there's no prior image dragging tokens along — that's the realistic pattern for most agent loops.

**Why is the proxy lower than the in-process pipeline?** The in-process adapter (81.9% / 90.1% on the same flow) can skip the model call entirely on no-change turns — the agent's own loop handles the skip. The proxy can't safely do that: it doesn't know whether the agent expects text, a `tool_use` block, or a structured JSON action, and getting the synthesized response wrong would break computer-use and most production agent loops. Use the proxy when you can't modify agent code; use the in-process adapter when you can.

A future `--synthesize-on-skip` proxy flag, scoped to agents with known output shapes (e.g., text-output change-detection prompts), could close more of the gap. It's intentionally **not** shipped in v0.1 — the proxy's current contract is "transparent rewrite, never synthesize," and that's the safer default.

For context: an MCP-based dogfood on a short Claude Code session was **+27% more expensive** than baseline because MCP tool definitions, tool-call args, and JSON cache churn dominated a 5-frame session. The proxy form has zero per-turn tax. Full investigation in [`RESULTS.md`](./RESULTS.md).

See [`RESULTS.md`](./RESULTS.md) for the full methodology, evolution, and per-frame verdicts; [`docs/DEMO_AND_EVAL.md`](./docs/DEMO_AND_EVAL.md) for demo and reproduction commands.

## Docs

- [`RESULTS.md`](./RESULTS.md) — full methodology, measurement evolution, proxy A/B validation, MCP overhead investigation
- [`docs/PROXY_IMPLEMENTATION.md`](./docs/PROXY_IMPLEMENTATION.md) — proxy implementation details
- [`DESIGN.md`](./DESIGN.md) — architecture and product direction
- [`docs/DEMO_AND_EVAL.md`](./docs/DEMO_AND_EVAL.md) — demo, eval, and measurement commands

## License

[MIT](./LICENSE)
