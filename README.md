# StateLens

> Screenshot gateway for computer-use agents. Drop-in Anthropic-compatible proxy that cuts input tokens 46-59% by replacing redundant screenshots with compact text observations. Same agent code, one env var change. **Measured: 70-82% input-token reduction and 81-90% cost reduction** on real Anthropic API calls across two UI flows.

StateLens sits between a UI agent and its reasoning model. It watches screenshot streams, filters redundant frames, extracts semantic state changes, and replaces expensive image input with compact text observations when it is safe to do so.

Use it when you are building or running screenshot-heavy browser/computer-use agents and want to stop paying for frames that did not meaningfully change.

## Architecture in one paragraph

StateLens is a **cost-arbitrage pipeline**. It uses a cheap-but-capable vision model (Anthropic Haiku by default) to extract text observations from screenshots, so your expensive primary model (Sonnet, GPT-4o, Gemini Pro — whichever you're committed to) only processes images on frames where vision genuinely matters. On frames that are pixel-identical to the prior frame, **no LLM is called at all** — the visual gate skips them locally. This means our savings are above and beyond any "just use a cheaper model" swap, because cheaper models still pay per frame; the visual gate doesn't.

## What's supported today

| Component | Supports | Multi-provider? |
|---|---|---|
| **Local API proxy** (`statelens proxy`) — **the recommended path** | Anthropic only today; OpenAI / Gemini planned | No (today) |
| **In-process library** (`observe`, `routeObservation`, `captureAndRoute`) | Any LLM provider you call yourself | **Yes — model-agnostic by design** |
| MCP server (`statelens serve`) — **secondary** (see [+27% MCP overhead investigation](./RESULTS.md)) | Any MCP-compatible client | Yes |
| **Internal VLM** (for the text observation step) | Anthropic Haiku | Hard-coded today; configurable VLM provider planned for v0.2.0 |

**Requirements**: an API key for whichever vision model you use. The default install uses Anthropic Haiku internally, so the proxy and the library's `observe()` need `ANTHROPIC_API_KEY` set. The library can be wired in front of any model for the *primary* call (the one the agent makes); only the internal Haiku step is currently Anthropic-bound.

**Library is model-agnostic today**: if you control your agent loop, `observe()` returns a route decision (`skip_vision` / `use_text_observation` / `use_full_vision`) plus a text summary. You decide which model to call on the resulting route. See [Use In Process](#use-in-process) for the code.

**Proxy is Anthropic-only today**: it speaks Anthropic's wire format (`/v1/messages`, base64 image content blocks). OpenAI- and Gemini-compatible proxies are planned for v0.2.0. If you need them sooner, the in-process library has zero provider lock-in.

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

## End-to-End: From `npm install` To Measured Savings

Three commands, one terminal, real Anthropic API dollars. No code changes to your agent.

### 1. Install

```bash
npm install -g statelens-sdk
export ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Start The Proxy

```bash
statelens proxy --provider anthropic --port 8443
```

The proxy is an Anthropic-compatible endpoint. It intercepts `POST /v1/messages`, runs the StateLens pipeline on the screenshot blocks, and forwards a rewritten request upstream.

### 3. Point Your Agent At It

Any Anthropic SDK-based computer-use agent works. The only line that changes:

```ts
const client = new Anthropic({
  baseURL: 'http://127.0.0.1:8443',  // ← that's the entire integration
});
```

### 4. Reproduce The Numbers

```bash
git clone https://github.com/zhizhongs/statelens.git && cd statelens
npm install && npm run build
bash demo/record.sh
```

You get a one-page report straight from `response.usage.input_tokens`, comparing the same agent code running direct vs through the proxy:

```text
                          direct      via proxy
  input tokens             18996         10215
  cost (USD)            $0.066768     $0.027457

  token reduction: 46.2%
  cost  reduction: 58.9%
```

Inspect what the proxy actually did:

```bash
curl http://127.0.0.1:8443/sessions/<id>/timeline
```

Numbers are real Anthropic API token counts and include the Haiku tokens StateLens spends internally — no "shifted to a cheaper model" trick. Full methodology in [`RESULTS.md`](./RESULTS.md).

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

## Use MCP (secondary)

> **Prefer the proxy if you have the choice.** We dogfooded an MCP-based Claude Code session against the same flow and measured **+27% MORE expensive** than baseline — MCP tool definitions, tool-call arg payloads, and JSON cache churn dominated short sessions. The proxy form has zero per-turn tax. Full investigation in [`RESULTS.md`](./RESULTS.md).

MCP makes sense only when the client can't take a `baseURL` override (some IDEs, some legacy clients). Otherwise, use the proxy.

If you do want MCP, add to `~/.cursor/mcp.json` (or the equivalent for Claude Code / Claude Desktop):

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

Tool use is voluntary — the agent has to decide to call StateLens tools. That's the main reason the proxy is preferred: it's automatic and transparent.

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

Ordered by recommendation, most to least:

| Surface | Status | Best for |
|---|---|---|
| **Local API proxy** (`statelens proxy`) | Built for Anthropic | SDK-based agents or binaries that support `baseURL` / endpoint overrides. **Recommended.** Transparent, no per-turn tax. |
| **In-process routing helper** | Built, model-agnostic | Custom Playwright/Puppeteer/browser-use style loops where you control the agent code. Highest savings ceiling (82-90%). |
| MCP server (`statelens serve`) | Built but secondary | Clients that can't take a `baseURL` override. Comes with per-turn MCP overhead — see the [+27% Claude Code regression](./RESULTS.md) before choosing this surface. |
| SDK middleware | Planned (v0.2.0) | Apps that instantiate the Anthropic/OpenAI SDK in code and can wrap the client |
| OpenAI / Gemini proxy | Planned (v0.2.0) | Same as the Anthropic proxy but for other providers |

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
