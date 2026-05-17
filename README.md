# StateLens

> Screenshot gateway for computer-use agents. StateLens ships as an MCP server, in-process routing library, and local Anthropic-compatible proxy. **Measured: 70-82% input-token reduction and 81-90% cost reduction** on real Anthropic API calls across two UI flows.

StateLens sits between a UI agent and its reasoning model. It watches screenshot streams, filters redundant frames, extracts semantic state changes, and replaces expensive image input with compact text observations when it is safe to do so.

Use it when you are building or running screenshot-heavy browser/computer-use agents and want to stop paying for frames that did not meaningfully change.

## Install

```bash
npm install -g statelens
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
npm install -g statelens
export ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Start The Proxy

```bash
statelens proxy --port 18443
```

The proxy is an Anthropic-compatible endpoint. It intercepts `POST /v1/messages`, runs the StateLens pipeline on the screenshot blocks, and forwards a rewritten request upstream.

### 3. Point Your Agent At It

Any Anthropic SDK-based computer-use agent works. The only line that changes:

```ts
const client = new Anthropic({
  baseURL: 'http://127.0.0.1:18443',  // ← that's the entire integration
});
```

### 4. Run The A/B And Read The Ledger

```bash
npm run measure -- demo/screenshots/login_flow
```

You get a one-page report straight from `response.usage.input_tokens`:

```text
Task: 12-frame login flow  •  Model: claude-sonnet-4-6
─────────────────────────────────────────────────────────────
Baseline (raw images)        StateLens proxy
  36,255 input tokens          6,562 input tokens
  $0.1162                      $0.0115
─────────────────────────────────────────────────────────────
  → 81.9% token reduction   90.1% cost reduction   100% accuracy
```

Inspect what the proxy actually did:

```bash
curl http://127.0.0.1:18443/sessions/<id>/timeline
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

### Region Evidence (opt-in)

Region Evidence is the middle rung between "text observation" and "full screenshot": StateLens swaps the screenshot for a text observation plus 1–3 small crops of just the changed regions. Enable it on the proxy with an env flag:

```bash
STATELENS_REGION_EVIDENCE=1 statelens proxy --provider anthropic --port 8443
```

When enabled, the proxy runs `observeWithEvidence()`, labels each changed region (`shipping_form`, `delivery_options`, `payment_method`, `login_form`, `error_message`, `navigation`, or a snake_case geometry fallback), and — for medium- or high-confidence localized keyframes — replaces the screenshot with one text block plus crop image blocks. Many-region, oversized, or low-confidence keyframes fall through to either `use_context_snapshot` (partial crops) or `use_full_vision`. Crop bytes are never logged unless `STATELENS_LOG_IMAGES=1` is also set.

See [`docs/REGION_EVIDENCE_DESIGN.md`](./docs/REGION_EVIDENCE_DESIGN.md) for the data model, confidence rules, and cost guardrails.

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
import { captureAndRoute } from 'statelens';

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
import { observe, routeObservation } from 'statelens';

const observation = await observe(screenshotBuffer, 'session-id', 'click_submit');
const route = routeObservation(observation);
```

Use the evidence-aware API when you want semantic region labels and optional crops:

```ts
import { observeWithEvidence, routeEvidenceObservation } from 'statelens';

const observation = await observeWithEvidence(screenshotBuffer, {
  sessionId: 'checkout_flow',
  actionLabel: 'click_continue',
  includeCrops: true,
});
const route = routeEvidenceObservation(observation);

switch (route.route) {
  case 'skip_vision':
  case 'use_text_observation':
    break;
  case 'use_region_evidence':
  case 'use_context_snapshot':
    // route.evidence is 1-3 small PNG crops of the changed regions.
    await reasoningModel({ text: route.context, images: route.evidence });
    break;
  case 'use_full_vision':
    await reasoningModel({ image: screenshotBuffer });
    break;
}
```

`observeWithEvidence()` shares the same per-session timeline as `observe()` — you can mix the two in the same session. Crops default off (`includeCrops: false`) so the call stays cheap when you only want labeled regions.

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
  -> optional region labeling + crop generation (observeWithEvidence)
  -> one of:
       skip_vision           (no meaningful change)
       use_text_observation  (text alone explains the change)
       use_region_evidence   (text + 1-3 small region crops)   [opt-in]
       use_context_snapshot  (partial crops + summary)         [opt-in]
       use_full_vision       (forward the original screenshot)
```

## Results

Measured with real Anthropic API token counts:

| Scenario | Frames | Token reduction | Cost reduction | Accuracy (lenient) |
|---|---:|---:|---:|---:|
| Login flow | 12 | 81.9% | 90.1% | 100.0% |
| Checkout flow | 10 | 69.9% | 81.2% | 77.8% |

The measurement harness includes internal Haiku usage, so the savings are not hidden by shifting work to a cheaper model.

See [`RESULTS.md`](./RESULTS.md) for the full methodology and [`docs/DEMO_AND_EVAL.md`](./docs/DEMO_AND_EVAL.md) for demo and reproduction commands.

## Docs

- [`docs/PROXY_IMPLEMENTATION.md`](./docs/PROXY_IMPLEMENTATION.md) — proxy implementation details
- [`docs/REGION_EVIDENCE_DESIGN.md`](./docs/REGION_EVIDENCE_DESIGN.md) — Region Evidence route, semantic labels, and crop generation
- [`DESIGN.md`](./DESIGN.md) — architecture and product direction
- [`docs/DEMO_AND_EVAL.md`](./docs/DEMO_AND_EVAL.md) — demo, eval, and measurement commands

## License

[MIT](./LICENSE)
