# Post-Phase 3 Agent Integration Design

Owner: Shared - Pipeline + Distribution  
References: [`../DESIGN.md`](../DESIGN.md), [`./ROLE_PIPELINE.md`](./ROLE_PIPELINE.md), [`./ROLE_DISTRIBUTION.md`](./ROLE_DISTRIBUTION.md), [`./PIPELINE_PHASE2_IMPLEMENTATION.md`](./PIPELINE_PHASE2_IMPLEMENTATION.md)  
Status: Supplementary design after Phase 3 pipeline reliability is complete

## Objective

Phase 3 made the StateLens pipeline reliable enough to be used as a library: screenshots go in, structured observations come out, and stage failures should return sensible observations instead of breaking the caller.

This document defines the next layer: integrating StateLens into real computer-use agent loops.

The core insight is:

> An agent policy prompt is useful, but it is not enough for reliable integration. StateLens should sit in code between screenshot capture and expensive vision reasoning wherever we control the agent runtime.

## Current State After Phase 3

StateLens currently has two practical entry points:

1. **Folder/demo mode**
   - The demo processes screenshots from a directory.
   - This proves the pipeline and timeline behavior, but it is not an agent integration.

2. **MCP tool mode**
   - The MCP server exposes `statelens_observe`.
   - The current tool path expects a local `screenshot_path`.
   - A compatible agent can call it, but the agent must deliberately save a screenshot and decide to call the tool.

This means StateLens is available to agents, but it does not automatically intercept their screenshot loop.

## Integration Boundary

The product-grade integration point is the boundary between:

```text
agent takes screenshot
  -> StateLens observes screenshot
  -> routing decision
  -> agent skips, uses text context, or calls full vision model
```

StateLens should not try to own browser automation, desktop control, or model planning. It should own observation compression and routing advice.

## Why Prompt Policy Alone Is Insufficient

An agent policy prompt can say:

```text
Before reasoning over any screenshot, call statelens_observe.
If changed=false, do not send the screenshot to a VLM.
If keyframe=true, use event_summary and text_diff first.
```

This is still voluntary. The model has to remember the instruction, call the tool with the right screenshot, interpret the result correctly, and then actually avoid the expensive vision path.

Policy prompts are best treated as a compatibility layer for closed agents where we cannot control the runtime.

They are not enough for:

- reliable token accounting
- repeatable demos
- automated evals
- agents that hold screenshots in memory instead of on disk
- preventing accidental full-screenshot VLM calls

## Integration Strategy

Use two tiers:

| Environment | Integration method | Reliability |
|---|---|---|
| Closed MCP clients such as Claude Code, Cursor, or Claude Desktop | MCP tool + policy prompt | Best effort |
| Custom agents, demos, eval harnesses, browser-use loops, Playwright loops | StateLens middleware in code | Reliable |

The middleware path is the one that proves the product.

## Target Runtime Flow

```ts
const screenshot = await computer.screenshot();
const observation = await observe(screenshot, sessionId, actionLabel);

if (!observation.changed) {
  return {
    route: 'skip_vision',
    context: 'No meaningful UI change detected.',
    observation,
  };
}

if (observation.keyframe && !observation.vlm_called) {
  return {
    route: 'use_text_observation',
    context: {
      summary: observation.event_summary,
      text_diff: observation.text_diff,
      regions: observation.changed_regions,
    },
    observation,
  };
}

return {
  route: 'use_full_vision',
  screenshot,
  observation,
};
```

## New Integration Artifacts

### 1. MCP Input Upgrade

Keep `screenshot_path`, but add in-memory screenshot support.

Proposed `statelens_observe` input:

```ts
{
  screenshot_path?: string;
  screenshot_base64?: string;
  mime_type?: 'image/png' | 'image/jpeg';
  session_id?: string;
  action_label?: string;
}
```

Validation rules:

- Require exactly one of `screenshot_path` or `screenshot_base64`.
- Decode base64 into a `Buffer` and pass it to `observe()`.
- Preserve the existing response shape.
- Keep `screenshot_path` for local tools and current demos.

Owner: Person B, because this touches `src/server.ts`.

### 2. Agent Routing Helper

Add a small adapter around `ObservationResult`.

Suggested file:

```text
src/adapters/routeObservation.ts
```

Suggested public type:

```ts
export type ObservationRoute =
  | {
      route: 'skip_vision';
      reason: string;
      observation: ObservationResult;
    }
  | {
      route: 'use_text_observation';
      context: string;
      observation: ObservationResult;
    }
  | {
      route: 'use_full_vision';
      reason: string;
      observation: ObservationResult;
    };
```

Routing policy:

| Observation | Route |
|---|---|
| `changed === false` | `skip_vision` |
| `keyframe === true && vlm_called === false` | `use_text_observation` |
| `keyframe === true && vlm_called === true` | `use_text_observation` if StateLens summary is enough for the caller, otherwise `use_full_vision` |
| `event_type === 'invalid_screenshot'` | `use_full_vision` or caller error handling |
| `event_type === 'analysis_error'` | `use_full_vision` |

The default conservative behavior should route analysis errors to full vision. StateLens should save tokens when confident, not hide uncertainty.

Owner: Shared. The helper can live outside `src/pipeline/` to avoid expanding Person A's locked pipeline surface.

### 3. Reference Playwright Integration

Build one real, testable agent loop before attempting broad integrations.

Suggested files:

```text
src/adapters/playwright.ts
demo/agent_loop/playwright_login.ts
tests/adapters/playwright.test.ts
```

The adapter should:

1. call `page.screenshot()`
2. pass the screenshot buffer to `observe()`
3. return an `ObservationRoute`
4. never call the downstream mocked VLM when the route is `skip_vision`
5. include `actionLabel` after user actions such as click/type/navigate

This is the best demo target because Playwright is deterministic and easy to test.

Owner: Person B, with Person A supporting route semantics if the pipeline needs a small export.

### 4. Policy Prompt

Still provide a policy prompt, but treat it as a fallback for closed clients.

Recommended policy:

```text
Before reasoning over any screenshot, call statelens_observe with the current screenshot and session_id.

If changed=false, do not send the screenshot to a vision model. Continue from the previous state unless the task explicitly requires visual inspection.

If keyframe=true and vlm_called=false, use event_summary, text_diff, and changed_regions as the primary observation.

If event_type is invalid_screenshot or analysis_error, fall back to normal screenshot reasoning.

Call statelens_timeline before summarizing the session or reporting what happened.
```

This helps MCP clients use StateLens well, but it should not be the only integration path.

## Implementation Plan

### Step 0 - Freeze Phase 3

Before integration work:

```bash
npm run build
npm test
```

Run the current screenshot demo. Commit Phase 3 by itself.

Reason: integration work touches different ownership boundaries and should not destabilize the core pipeline patch.

### Step 1 - Upgrade MCP Observe Input

Implement base64 support in `src/server.ts`.

Acceptance:

- Existing `screenshot_path` callers still work.
- New `screenshot_base64` callers work.
- Supplying both path and base64 returns a validation error.
- Supplying neither returns a validation error.

### Step 2 - Add Routing Helper

Implement `routeObservation()` and tests using synthetic `ObservationResult` objects.

Acceptance:

- no-change routes to `skip_vision`
- text-sufficient keyframe routes to `use_text_observation`
- invalid screenshot routes conservatively
- analysis error routes conservatively

### Step 3 - Build Reference Agent Loop

Implement a Playwright reference adapter and a demo loop.

Acceptance:

- unchanged screenshots do not call the mocked VLM
- text-only keyframes are passed as text context
- full-vision fallback still has access to the screenshot buffer
- route decisions are logged for demo visibility

### Step 4 - Document Closed-Client Usage

Add README instructions for MCP clients:

- install command
- MCP config
- policy prompt
- expected `statelens_observe` behavior
- limitations: StateLens cannot force closed clients to call it before every screenshot

## Non-Goals

Do not do these in the first integration pass:

- replace Claude Code or Cursor's internal screenshot pipeline
- add a browser extension
- add global OS screenshot interception
- refactor the Phase 3 pipeline API
- require new model providers
- make policy prompt compliance the headline claim

## Risks

| Risk | Mitigation |
|---|---|
| Closed clients ignore the policy prompt | Present MCP integration as best effort; use middleware demos for proof |
| Base64 screenshots increase MCP payload size | Keep `screenshot_path` support and prefer buffers in in-process adapters |
| Analysis fallbacks accidentally hide UI changes | Route `invalid_screenshot` and `analysis_error` conservatively to full vision |
| Integration work muddies Phase 3 reliability | Commit Phase 3 separately before adapter work |
| Token savings are overstated | Continue adding StateLens internal VLM usage through `getVlmCumulativeUsage()` |

## Definition of Done

The post-Phase-3 integration layer is done when:

- MCP `statelens_observe` accepts both file paths and base64 screenshots.
- A routing helper returns explicit `skip_vision`, `use_text_observation`, or `use_full_vision` decisions.
- A Playwright reference integration demonstrates StateLens in the screenshot loop.
- Tests prove unchanged screenshots do not reach the mocked downstream VLM.
- README or docs include the policy prompt for closed MCP clients.
- The original Phase 3 pipeline tests still pass.
