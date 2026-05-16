# StateLens Proxy Implementation Design

## 1. Goal

Build a local Anthropic-compatible proxy that gates screenshot-bearing model requests with the existing StateLens pipeline.

The proxy must be additive. It must not delete, rename, or change the existing MCP server behavior in `src/server.ts`. MCP remains the tool-aware integration surface. The proxy is a new delivery surface for SDK-based agents that can set a model API base URL.

MVP command:

```bash
statelens proxy --provider anthropic --port 8443
export ANTHROPIC_BASE_URL=http://localhost:8443
```

MVP upstream:

```text
POST /v1/messages -> https://api.anthropic.com/v1/messages
```

MVP behavior:

- If the request has no screenshot image block, forward unchanged.
- If the request has a decodable screenshot, call `observe()` and `routeObservation()`.
- If StateLens says full vision is needed, forward unchanged.
- If StateLens has enough text context, replace the screenshot image block with a text observation and forward.
- If StateLens detects no meaningful change, replace the screenshot image block with a no-change text observation and forward.
- If anything is ambiguous or fails, forward unchanged.

No transparent MITM. No custom CA. No hosted service in the MVP.

## 2. Non-Goals

- Do not implement OpenAI-compatible proxying in the first pass.
- Do not synthesize provider responses by default.
- Do not support arbitrary binary MITM interception.
- Do not persist screenshots or raw request bodies by default.
- Do not change MCP tool names, schemas, descriptions, or return shapes.
- Do not require a new web framework dependency for MVP. Use Node 20 `node:http` and `fetch` unless a later implementation proves this is too painful.

## 3. Current Code Reuse

Use existing exports:

```typescript
import { observe, getTimeline, resetSession } from '../pipeline/index.js';
import { routeObservation } from '../adapters/routeObservation.js';
```

Important current behavior:

- `observe()` owns previous-screenshot state by `sessionId`.
- `routeObservation()` maps observations to `skip_vision`, `use_text_observation`, or `use_full_vision`.
- `vlmExplain()` currently constructs `new Anthropic()` and may read `ANTHROPIC_BASE_URL`.

The proxy implementation must fix internal VLM recursion. When the user points `ANTHROPIC_BASE_URL` at the local proxy, StateLens's own Haiku calls must still go to the real upstream provider.

Required pipeline change:

```typescript
// src/pipeline/vlmExplainer.ts
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required for vlmExplain()');
    }

    const baseURL =
      process.env.STATELENS_INTERNAL_ANTHROPIC_BASE_URL ??
      (process.env.STATELENS_PROXY_ACTIVE === '1'
        ? process.env.STATELENS_ANTHROPIC_UPSTREAM_BASE_URL ?? 'https://api.anthropic.com'
        : undefined);

    client = new Anthropic(baseURL ? { baseURL } : undefined);
  }
  return client;
}
```

The proxy command sets `STATELENS_PROXY_ACTIVE=1` in-process before any pipeline call.

## 4. File Plan

Add these files:

```text
src/gateway/
  types.ts                    Shared gateway types
  anthropicImageBlocks.ts     Extract/replace Anthropic image blocks
  requestRouting.ts           ObservationRoute -> request rewrite policy
  session.ts                  Session id and action label resolution

src/proxy/
  anthropic.ts                HTTP server and /v1/messages handler
  upstream.ts                 Forward requests to upstream Anthropic

tests/gateway/
  anthropicImageBlocks.test.ts
  requestRouting.test.ts
  session.test.ts

tests/proxy/
  anthropicProxy.test.ts
```

Update these files:

```text
src/index.ts                  Add `proxy` command
src/pipeline/vlmExplainer.ts  Add internal upstream override
package.json                  Add `proxy` script only if useful for dev
README.md                     Mark Anthropic proxy support as implemented
```

Do not modify:

```text
src/server.ts                 MCP server stays behaviorally stable
```

## 5. CLI Contract

Supported MVP flags:

```bash
statelens proxy \
  --provider anthropic \
  --host 127.0.0.1 \
  --port 8443 \
  --upstream https://api.anthropic.com
```

Defaults:

| Option | Default |
|---|---|
| `--provider` | `anthropic` |
| `--host` | `127.0.0.1` |
| `--port` | `8443` |
| `--upstream` | `https://api.anthropic.com` |

Environment overrides:

| Env var | Meaning |
|---|---|
| `STATELENS_PROXY_HOST` | Default host |
| `STATELENS_PROXY_PORT` | Default port |
| `STATELENS_ANTHROPIC_UPSTREAM_BASE_URL` | Upstream provider base URL |
| `STATELENS_INTERNAL_ANTHROPIC_BASE_URL` | Explicit base URL for StateLens internal Haiku calls |
| `STATELENS_SESSION_ID` | Fixed session id for simple demos |
| `STATELENS_LOG_LEVEL` | `silent`, `info`, or `debug` |
| `STATELENS_LOG_IMAGES` | `1` enables raw image debug logging; default off |
| `STATELENS_PROXY_HARD_SKIP` | Future opt-in synthetic response mode; default off |

Startup log goes to stderr:

```text
StateLens proxy listening on http://127.0.0.1:8443
Provider: anthropic
Upstream: https://api.anthropic.com
Mode: fail-open text rewrite
```

## 6. HTTP Contract

Local endpoints:

```text
GET  /health
POST /v1/messages
GET  /sessions/:sessionId/timeline
POST /sessions/:sessionId/reset
```

`GET /health` response:

```json
{
  "ok": true,
  "name": "statelens-proxy",
  "provider": "anthropic"
}
```

`POST /v1/messages`:

- Accepts Anthropic Messages API JSON.
- Forwards all provider auth headers.
- Preserves `anthropic-version`, `anthropic-beta`, `x-api-key`, `authorization`, and request body fields.
- Rewrites only the selected screenshot image block.
- Returns the upstream response status, headers, and body.

Debug endpoints:

- `GET /sessions/:sessionId/timeline` returns `getTimeline(sessionId)`.
- `POST /sessions/:sessionId/reset` calls `resetSession(sessionId)`.

## 7. TypeScript Interfaces

```typescript
export type Provider = 'anthropic';

export interface ProxyOptions {
  provider: Provider;
  host: string;
  port: number;
  upstreamBaseUrl: string;
  logLevel: 'silent' | 'info' | 'debug';
}

export interface GatewayContext {
  provider: Provider;
  sessionId: string;
  actionLabel?: string;
  requestId: string;
}

export interface ExtractedImageBlock {
  messageIndex: number;
  contentIndex: number;
  mediaType: 'image/png' | 'image/jpeg';
  data: string;
  bytes: Buffer;
}

export type GatewayAction =
  | 'forward_unchanged'
  | 'forward_rewritten';

export interface GatewayRewriteResult {
  action: GatewayAction;
  reason: string;
  requestBody: unknown;
  observation?: ObservationResult;
  route?: ObservationRoute;
}
```

## 8. Anthropic Payload Handling

MVP supports this image shape:

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "..."
  }
}
```

Extraction algorithm:

1. Validate the JSON body is an object.
2. Validate `messages` is an array.
3. Find the final user message.
4. In that final user message, find image blocks with `source.type === "base64"`.
5. Decode only the last decodable image block.
6. Return no image if:
   - no final user message exists,
   - no image block exists,
   - media type is not PNG/JPEG,
   - base64 decoding fails,
   - decoded buffer is empty.

Why last image only:

- It minimizes accidental removal of non-screenshot reference images.
- Computer-use loops usually send the current screenshot as the latest image.
- Multi-image change-detection baselines are not the target of proxy MVP.

Replacement algorithm:

1. Deep clone the JSON request body.
2. Replace the selected image block with a text block.
3. Leave all other content blocks in order.
4. Leave all non-selected images intact.

Text replacement block:

```json
{
  "type": "text",
  "text": "StateLens observation for the latest UI screenshot:\nEvent: ...\nSummary: ...\n..."
}
```

Do not append observation text to `system`; keep it in the user message where the screenshot was.

## 9. Routing Rules

Base policy uses `routeObservation(observation)`, then applies gateway-specific guards.

Gateway guard rules:

| Condition | Action |
|---|---|
| No image block | Forward unchanged |
| Image decode error | Forward unchanged |
| `observation.event_type === "session_start"` | Forward unchanged |
| `observation.event_type === "invalid_screenshot"` | Forward unchanged |
| `observation.event_type === "analysis_error"` | Forward unchanged |
| `route.route === "use_full_vision"` | Forward unchanged |
| `route.route === "use_text_observation"` | Replace selected image with `route.context` |
| `route.route === "skip_vision"` | Replace selected image with no-change text |

The `session_start` guard is important. The first screenshot often needs full visual grounding. Current `routeObservation()` treats keyframes as text-usable, but "First screenshot in session" is not enough context for a generic agent. The proxy should fail open on first frame unless a future option explicitly enables first-frame gating.

No-change text block:

```text
StateLens observation for the latest UI screenshot:
Event: no_change
Summary: No meaningful UI change was detected since the previous screenshot in this StateLens session.

The screenshot image was removed to save vision tokens. Continue from the prior UI state unless the task explicitly requires raw visual inspection.
```

Text-observation block:

```text
StateLens observation for the latest UI screenshot:
Event: ${observation.event_type}
Summary: ${observation.event_summary}
Text appeared: ${...}
Text disappeared: ${...}
Regions changed: ${...}

The screenshot image was removed to save vision tokens. Use this observation as the UI state for this turn unless the task explicitly requires raw visual inspection.
```

## 10. Session Resolution

Session id priority:

1. `x-statelens-session-id` request header.
2. `metadata.statelens_session_id` in the Anthropic request body.
3. `STATELENS_SESSION_ID` environment variable.
4. `"default"`.

Action label priority:

1. `x-statelens-action-label` request header.
2. `metadata.statelens_action_label` in the Anthropic request body.
3. Undefined.

Do not forward `x-statelens-*` headers upstream.

Do not mutate provider `metadata` by default. A later opt-in can add StateLens route metadata upstream, but the MVP should avoid changing customer-visible request metadata.

## 11. Upstream Forwarding

`src/proxy/upstream.ts` should expose:

```typescript
export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export async function forwardAnthropicRequest(args: {
  upstreamBaseUrl: string;
  path: string;
  method: string;
  headers: Headers;
  body: string;
}): Promise<Response>;
```

Forwarding rules:

- Build upstream URL as `${upstreamBaseUrl}${path}`.
- Reject paths other than `/v1/messages` for MVP with `404`.
- Copy request headers except:
  - `host`
  - `content-length`
  - `connection`
  - `x-statelens-session-id`
  - `x-statelens-action-label`
- Set `content-type: application/json` for rewritten requests.
- Let `fetch` compute content length.
- Preserve upstream status code and body.
- Copy upstream headers except hop-by-hop headers.

Hop-by-hop response headers to drop:

```text
connection
keep-alive
proxy-authenticate
proxy-authorization
te
trailer
transfer-encoding
upgrade
```

## 12. Streaming

MVP streaming policy:

- If `body.stream !== true`, handle normally.
- If `body.stream === true` and the request is forwarded unchanged, pass through the upstream stream.
- If `body.stream === true` and the request is rewritten, forward the rewritten request with `stream: true` and pipe the provider stream back unchanged.

Do not implement synthetic streaming responses in MVP.

Implementation detail:

- Node 20 `fetch` can return a web `ReadableStream`.
- Convert it to the Node response with `Readable.fromWeb()` if needed.
- Preserve `content-type: text/event-stream` when upstream returns SSE.

## 13. Logging and Metrics

Default logs must not include raw screenshots, base64 data, full prompts, API keys, or provider responses.

Info log per screenshot-bearing request:

```json
{
  "request_id": "sl_...",
  "provider": "anthropic",
  "session_id": "default",
  "route": "use_text_observation",
  "event_type": "error_appeared",
  "vlm_called": false,
  "latency_ms": 84,
  "rewritten": true
}
```

Debug mode can include:

- selected image media type,
- selected image byte length,
- observation summary,
- changed region labels,
- upstream latency.

Image logging requires `STATELENS_LOG_IMAGES=1` and should write to a temp/debug directory, not stdout/stderr.

## 14. Error Handling

Fail-open cases:

- JSON parse error: return `400` because there is no valid provider request to forward.
- Unsupported local path: return `404`.
- No image block: forward unchanged.
- Image decode error: forward unchanged.
- `observe()` throws: forward unchanged.
- `routeObservation()` throws: forward unchanged.
- Request rewrite throws: forward unchanged.
- Upstream fetch fails: return `502` with a short JSON error.

Do not hide upstream errors. If Anthropic returns `4xx` or `5xx`, return that exact status and body to the SDK.

## 15. Tests

Unit tests:

```text
tests/gateway/anthropicImageBlocks.test.ts
  - extracts last image from final user message
  - ignores assistant images and earlier user images
  - rejects unsupported media type
  - rejects invalid base64
  - replaces selected image with text block without changing other content

tests/gateway/requestRouting.test.ts
  - no image -> forward unchanged
  - session_start -> forward unchanged
  - invalid_screenshot -> forward unchanged
  - analysis_error -> forward unchanged
  - use_full_vision -> forward unchanged
  - use_text_observation -> forward rewritten
  - skip_vision -> forward rewritten with no-change text

tests/gateway/session.test.ts
  - header session wins
  - metadata session is second
  - env session is third
  - default fallback
  - x-statelens headers are stripped upstream
```

Integration tests:

```text
tests/proxy/anthropicProxy.test.ts
  - GET /health returns ok
  - no-image POST /v1/messages reaches fake upstream unchanged
  - image request with mocked text route reaches fake upstream without selected image
  - first screenshot forwards unchanged
  - upstream 401 is passed through exactly
  - upstream network failure returns 502
```

Test strategy:

- Use a local fake upstream HTTP server.
- Mock `observe()` for proxy tests where possible.
- Keep real pipeline coverage in existing pipeline tests.
- Do not call the real Anthropic API in unit or integration tests.

## 16. Implementation Milestones

### Milestone 1: Payload helpers

Deliver:

- `src/gateway/types.ts`
- `src/gateway/anthropicImageBlocks.ts`
- unit tests for extraction/replacement

Acceptance:

- Can locate and replace the final screenshot block in Anthropic messages without changing unrelated fields.

### Milestone 2: Routing policy

Deliver:

- `src/gateway/requestRouting.ts`
- text block formatting helpers
- unit tests for all route guards

Acceptance:

- Given a mocked `ObservationResult` and `ObservationRoute`, returns the correct `GatewayRewriteResult`.

### Milestone 3: Local HTTP proxy

Deliver:

- `src/proxy/anthropic.ts`
- `src/proxy/upstream.ts`
- `/health`
- `/v1/messages`
- debug timeline/reset endpoints

Acceptance:

- No-image requests pass through to fake upstream.
- Rewritten requests reach fake upstream as valid Anthropic JSON.

### Milestone 4: CLI wiring

Deliver:

- `statelens proxy` command in `src/index.ts`
- env/flag parsing
- startup logs

Acceptance:

```bash
npm run build
node dist/src/index.js proxy --port 8443
curl http://127.0.0.1:8443/health
```

### Milestone 5: Internal VLM bypass

Deliver:

- `vlmExplainer.ts` base URL override
- regression test or manual test proving internal Haiku does not call localhost proxy

Acceptance:

- With `ANTHROPIC_BASE_URL=http://localhost:8443`, StateLens internal VLM calls use `STATELENS_ANTHROPIC_UPSTREAM_BASE_URL` or `https://api.anthropic.com`.

### Milestone 6: Live validation

Deliver:

- `eval/proxy_smoke.ts` or a documented manual smoke script

Acceptance:

- Existing Anthropic SDK can be pointed at localhost.
- Proxy records route decisions.
- Fake or real screenshot-bearing request is rewritten as expected.
- Token accounting still includes internal Haiku usage.

## 17. Manual Smoke Test

Terminal 1:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run build
node dist/src/index.js proxy --port 8443
```

Terminal 2:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_BASE_URL=http://127.0.0.1:8443
node scripts/proxy_smoke_request.mjs
```

Expected:

- First screenshot request forwards unchanged because it is `session_start`.
- Second identical screenshot request is rewritten to text-only no-change context.
- Upstream response is returned to the SDK normally.
- `GET /sessions/default/timeline` shows both observations.

## 18. Open Questions

1. Should the default session be `"default"` or should the proxy derive a session from API key plus process metadata?
2. Should the proxy ever remove more than one image block in a request?
3. Should first-frame gating be available as an opt-in for agents that already have page state elsewhere?
4. Should SDK middleware ship before the local proxy to validate rewrite behavior with less operational surface?
5. How should OpenAI Responses API image inputs map into the provider-neutral `ExtractedImageBlock` shape?

## 19. Release Criteria

Proxy is ready to document as usable when:

- `statelens serve` MCP behavior is unchanged.
- `statelens proxy --provider anthropic` starts locally.
- Anthropic SDK requests with no images pass through unchanged.
- Anthropic SDK requests with repeated screenshots are rewritten safely.
- First screenshots and analysis failures fail open.
- Internal StateLens VLM calls do not recurse through the proxy.
- Unit and integration tests pass without real API calls.
- README clearly marks proxy support as implemented, not planned.
