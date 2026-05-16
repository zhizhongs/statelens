# StateLens SDK Middleware Implementation Design

## 1. Goal

Build an in-process SDK wrapper that gates screenshot-bearing model calls before the provider SDK sends HTTP. This gives users the same request-rewrite benefits as the local proxy without running a separate proxy process.

MVP target:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from 'statelens/anthropic';

const anthropic = wrapAnthropic(new Anthropic(), {
  sessionId: 'checkout-run',
});

await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 512,
  messages,
});
```

What it should do:

- Intercept `client.messages.create()`.
- Detect Anthropic base64 screenshot image blocks.
- Run `observe()` and `routeObservation()`.
- Rewrite safe screenshot inputs into compact text observations.
- Forward ambiguous/error/first-frame requests unchanged.
- Preserve SDK behavior for all non-image requests.

The wrapper must be additive. It must not change MCP behavior, proxy behavior, or the core pipeline contract.

## 2. Relationship To Other Modes

| Mode | Where StateLens sits | Code change | Separate process | Current status |
|---|---|---:|---:|---|
| MCP | Tool layer | config/prompt | yes | built |
| Proxy | HTTP layer via `ANTHROPIC_BASE_URL` | usually no | yes | built for Anthropic |
| SDK middleware | SDK object layer | small wrapper call | no | planned |
| In-process adapter | Agent loop layer | loop changes | no | built |

SDK middleware and proxy solve the same basic problem at different insertion points. Users usually choose one, not both.

Use SDK middleware when:

- the app constructs the SDK client in code,
- the user can change that construction site,
- running a local proxy process is inconvenient,
- preserving the normal provider SDK API matters.

Use proxy when:

- the app exposes `baseURL` but not the SDK object,
- the agent is a binary or polyglot system,
- a team wants one shared local/network gateway.

## 3. Non-Goals

- Do not implement OpenAI/Gemini wrappers in the MVP.
- Do not replace or remove `statelens proxy`.
- Do not change `src/server.ts` or MCP tool definitions.
- Do not hand-roll a new pipeline state store; use `observe()` session IDs.
- Do not synthesize full provider responses by default.
- Do not mutate caller-provided request objects in place.
- Do not change provider SDK retry, timeout, beta, tool, or stream semantics outside screenshot-bearing requests.

## 4. File Plan

Add:

```text
src/middleware/
  anthropic.ts              wrapAnthropic(client, options)
  syntheticAnthropic.ts     Optional synthetic response helpers

tests/middleware/
  anthropicMiddleware.test.ts
  syntheticAnthropic.test.ts
```

Update:

```text
src/library.ts              Export wrapAnthropic after implementation
package.json                Add ./anthropic subpath export
README.md                   Add public SDK middleware usage once implemented
docs/README.md              Link this design doc
```

Reuse existing gateway code:

```text
src/gateway/anthropicImageBlocks.ts
src/gateway/requestRouting.ts
src/gateway/session.ts
```

The middleware should not duplicate Anthropic payload parsing. The proxy and SDK wrapper should share the same request-rewrite policy.

## 5. Public API

```ts
import type Anthropic from '@anthropic-ai/sdk';

export interface WrapAnthropicOptions {
  sessionId?: string | (() => string);
  actionLabel?: string | ((request: unknown) => string | undefined);
  mode?: 'rewrite' | 'rewrite_with_synthetic_skip';
  failOpen?: boolean;
  onObservation?: (event: AnthropicMiddlewareEvent) => void;
}

export interface AnthropicMiddlewareEvent {
  sessionId: string;
  actionLabel?: string;
  route: 'forward_unchanged' | 'forward_rewritten' | 'synthetic_skip';
  reason: string;
  eventType?: string;
  vlmCalled?: boolean;
  latencyMs: number;
}

export function wrapAnthropic<T extends Anthropic>(
  client: T,
  options?: WrapAnthropicOptions
): T;
```

Default options:

```ts
{
  sessionId: 'default',
  mode: 'rewrite',
  failOpen: true
}
```

`mode: 'rewrite'`:

- no-change and text-observation routes replace selected screenshot image blocks with text and call the real SDK.
- full-vision, first-frame, and error routes forward unchanged.

`mode: 'rewrite_with_synthetic_skip'`:

- same as `rewrite`, except `skip_vision` can return a synthetic Anthropic-like text response without calling the provider.
- this mode more closely matches the measurement harness savings, but is opt-in because some agents rely on every model turn for planning/tool calls.

## 6. Implementation Shape

The wrapper should preserve object shape as much as possible:

```ts
export function wrapAnthropic<T extends Anthropic>(
  client: T,
  options: WrapAnthropicOptions = {}
): T {
  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = async (request: any, requestOptions?: any) => {
    const next = await rewriteAnthropicSdkRequest(request, options);

    if (next.action === 'synthetic_skip') {
      return buildSyntheticAnthropicMessage(request, next);
    }

    return originalCreate(next.requestBody, requestOptions);
  };

  return client;
}
```

Whether to mutate the SDK client directly or return a proxy object is an implementation decision. Prefer returning a proxy object if it can preserve types cleanly; prefer mutating only if TypeScript makes the proxy too awkward.

Required helper:

```ts
export async function rewriteAnthropicSdkRequest(args: {
  requestBody: unknown;
  options: Required<WrapAnthropicOptions>;
}): Promise<{
  action: 'forward_unchanged' | 'forward_rewritten' | 'synthetic_skip';
  requestBody: unknown;
  reason: string;
  observation?: ObservationResult;
  route?: ObservationRoute;
}>;
```

The helper is where tests should focus. The wrapper itself should stay thin.

## 7. Request Rewriting Policy

Use the same image selection rules as the proxy:

1. Request body must be an object.
2. `messages` must be an array.
3. Select the final user message.
4. Select the last base64 image block in that final user message.
5. Decode PNG/JPEG only.
6. If anything is unsupported, forward unchanged.

Then:

```ts
const observation = await observe(image.bytes, sessionId, actionLabel);
const route = routeObservation(observation);
const rewrite = rewriteAnthropicRequestForRoute({ requestBody, image, route });
```

SDK middleware-specific guard:

| Condition | Action |
|---|---|
| no image | call original SDK unchanged |
| `session_start` | call original SDK unchanged |
| `invalid_screenshot` | call original SDK unchanged |
| `analysis_error` | call original SDK unchanged |
| `use_full_vision` | call original SDK unchanged |
| `use_text_observation` | call original SDK with rewritten text-only request |
| `skip_vision`, mode `rewrite` | call original SDK with no-change text-only request |
| `skip_vision`, mode `rewrite_with_synthetic_skip` | return synthetic response |

## 8. Synthetic Skip Response

Synthetic responses must be opt-in.

Anthropic-like shape:

```ts
{
  id: 'msg_statelens_skip_<uuid>',
  type: 'message',
  role: 'assistant',
  model: request.model,
  content: [
    {
      type: 'text',
      text: 'StateLens: no meaningful UI change was detected since the previous screenshot.'
    }
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 0,
    output_tokens: 0
  }
}
```

Limitations:

- This may not match every field the Anthropic SDK returns in every version.
- It should not be used when the request contains tools or requires tool-use planning.
- If `tools` or `tool_choice` are present, default back to rewrite-and-forward even in synthetic mode unless the user opts into `allowSyntheticToolTurns`.

Do not synthesize streaming responses in MVP.

## 9. Streaming

MVP policy:

- Non-streaming `messages.create()` is fully supported.
- Streaming requests with no rewrite pass through unchanged.
- Streaming requests that require rewrite can be forwarded with the rewritten body and original stream option.
- Synthetic skip for streaming is not supported; fall back to rewritten forwarding.

Tests should include `stream: true` pass-through and rewritten forwarding, but not assert full event-stream behavior from the real SDK.

## 10. Session And Action Labels

Session id priority:

1. `options.sessionId()` if function.
2. `options.sessionId` if string.
3. `request.metadata.statelens_session_id` if present.
4. `process.env.STATELENS_SESSION_ID` if present.
5. `'default'`.

Action label priority:

1. `options.actionLabel(request)` if function.
2. `options.actionLabel` if string.
3. `request.metadata.statelens_action_label` if present.
4. undefined.

The wrapper should not add StateLens metadata to provider requests by default.

## 11. Error Handling

Default: fail open.

If extraction, decoding, `observe()`, routing, or rewriting throws:

- call `options.onObservation` with route `forward_unchanged` and the error reason,
- call the original SDK request unchanged,
- do not throw the StateLens error unless `failOpen: false`.

With `failOpen: false`, StateLens errors should throw before the provider call. This is useful in tests and strict debugging.

Provider SDK errors must pass through unchanged.

## 12. Internal VLM Recursion

SDK middleware does not need the proxy recursion guard because it does not set `ANTHROPIC_BASE_URL`. Still, it uses the same pipeline as proxy, so internal Haiku calls continue to use the existing `vlmExplainer.ts` client behavior.

If the user's app has already set `ANTHROPIC_BASE_URL` to the StateLens proxy and also wraps the SDK, they are double-integrating. Document this as unsupported:

```text
Use either wrapAnthropic() or statelens proxy for a given client, not both.
```

## 13. Tests

Unit tests:

```text
tests/middleware/anthropicMiddleware.test.ts
  - no-image request calls original create unchanged
  - first screenshot calls original create unchanged
  - identical second screenshot rewrites image to no-change text in rewrite mode
  - text-sufficient change rewrites image to observation text
  - analysis_error fails open and forwards unchanged
  - failOpen:false throws StateLens errors
  - request object is not mutated
  - requestOptions are passed to original create
  - onObservation receives route, event type, and latency
  - stream:true no-image request passes through unchanged

tests/middleware/syntheticAnthropic.test.ts
  - builds Anthropic-like response shape
  - reports zero usage
  - avoids synthetic responses when tools are present
```

Integration smoke:

```ts
const raw = new Anthropic();
const client = wrapAnthropic(raw, { sessionId: 'smoke' });
await client.messages.create({ ... });
```

Do not call real Anthropic in automated tests. Use a fake client with `messages.create = vi.fn()`.

## 14. Packaging

After implementation, expose:

```json
{
  "exports": {
    ".": {
      "types": "./dist/src/library.d.ts",
      "import": "./dist/src/library.js"
    },
    "./anthropic": {
      "types": "./dist/src/middleware/anthropic.d.ts",
      "import": "./dist/src/middleware/anthropic.js"
    }
  }
}
```

Also re-export from root only if the added dependency/type weight remains acceptable:

```ts
export { wrapAnthropic } from './middleware/anthropic.js';
export type { WrapAnthropicOptions } from './middleware/anthropic.js';
```

Public docs should prefer:

```ts
import { wrapAnthropic } from 'statelens/anthropic';
```

This keeps provider-specific wrappers separate from provider-neutral core exports.

## 15. Implementation Milestones

### Milestone 1: Pure rewrite helper

Deliver:

- `src/middleware/anthropic.ts`
- `rewriteAnthropicSdkRequest()`
- tests for no-image, session-start, text rewrite, skip rewrite, fail-open

Acceptance:

- Wrapper-independent tests prove request rewrite behavior with fake observations.

### Milestone 2: Client wrapper

Deliver:

- `wrapAnthropic()`
- preservation of `requestOptions`
- `onObservation` callback

Acceptance:

- Fake client receives unchanged or rewritten request bodies as expected.

### Milestone 3: Synthetic skip mode

Deliver:

- `src/middleware/syntheticAnthropic.ts`
- opt-in `mode: 'rewrite_with_synthetic_skip'`

Acceptance:

- Identical second screenshot can avoid original SDK call when tools are absent.

### Milestone 4: Packaging and docs

Deliver:

- `package.json` `./anthropic` export
- README usage section
- docs update

Acceptance:

```ts
import { wrapAnthropic } from 'statelens/anthropic';
```

works after `npm run build`.

## 16. Release Criteria

SDK middleware is ready to mark built when:

- `wrapAnthropic()` exists and is exported through `statelens/anthropic`.
- Non-image Anthropic requests pass through unchanged.
- Screenshot-bearing requests rewrite safely.
- First frames and failures fail open.
- Synthetic skip is opt-in.
- Existing MCP and proxy tests still pass.
- README clearly distinguishes SDK middleware from proxy and MCP.
