# Post-Phase 3 Agentic Testing Integration Design

Owner: Shared - Pipeline + Distribution  
References: [`../DESIGN.md`](../DESIGN.md), [`./POST_PHASE3_AGENT_INTEGRATION.md`](./POST_PHASE3_AGENT_INTEGRATION.md), [`./ROLE_PIPELINE.md`](./ROLE_PIPELINE.md), [`./ROLE_DISTRIBUTION.md`](./ROLE_DISTRIBUTION.md)  
Status: Supplementary design for the next product layer after the Phase 3 pipeline

## Does This Affect Current Work?

No. This is additive.

The Phase 3 pipeline remains the foundation:

```text
screenshot Buffer
  -> observe()
  -> ObservationResult
  -> TimelineResult
```

This design does not require changing the locked pipeline contract. It adds an agentic testing integration layer on top of the completed pipeline so StateLens can reduce cost during real testing loops.

Do not mix this into the Phase 3 reliability commit. Freeze Phase 3 first, then implement this as a separate milestone.

## Product Thesis

The strongest product wedge for StateLens is not folder replay. Folder replay is useful for demos and measurement, but real users want:

```text
agent explores website
  -> agent generates or repairs tests
  -> agent repeatedly observes page state
  -> StateLens compresses redundant screenshots and state checks
  -> fewer expensive model calls
```

StateLens should become the cost and observability layer for agentic web testing loops.

## Primary Integration Target

### Playwright Test Agents

Playwright is the first target because it is already the mainstream developer testing substrate and now has an official agentic testing loop.

Official docs: [Playwright Test Agents](https://playwright.dev/docs/test-agents)

Playwright Test Agents include:

- `planner`: explores the app and writes a Markdown test plan
- `generator`: turns the plan into Playwright tests
- `healer`: replays failing tests and repairs them

The biggest StateLens opportunity is the `healer` loop, because failed tests often trigger repeated observation, screenshot inspection, retry, and repair.

### Important Constraint

Playwright MCP already uses accessibility snapshots by default and explicitly avoids vision models for normal web pages.

Official docs: [Playwright MCP](https://playwright.dev/mcp/introduction)

So StateLens should not compete with Playwright snapshots. It should compress the cases where screenshots or visual fallback still matter:

- canvas apps
- charts and graphs
- maps
- image editors
- custom widgets without good ARIA
- visual regression or screenshot failure review
- healer loops that repeatedly inspect the same failing UI
- agentic test tools that use runtime screenshots instead of generated code

## Secondary Integration Targets

### Browserbase Stagehand

Stagehand is a strong second target because it is an AI browser automation SDK and exposes natural-language browser actions.

Official site: [Browserbase Stagehand](https://www.browserbase.com/stagehand/)

Why it matters:

- It is open source.
- It targets browser agents directly.
- It can run locally or on Browserbase.
- It already has AI-driven `act`, `extract`, `observe`, and `agent` primitives.
- StateLens can sit between page screenshots and model observations when Stagehand needs visual context.

### Momentic

Momentic is useful market validation, but it is less ideal as the first integration because it is a closed commercial testing platform.

Official site: [Momentic](https://momentic.ai/)

Their public positioning is close to the customer problem: plain-English tests, runtime execution, self-healing locators, and an AI agent that interprets test steps at run time. Study it as a competitor or future partner, but build first on open surfaces.

## Target Architecture

```text
Playwright / Stagehand / custom testing agent
  -> action executes
  -> page screenshot captured
  -> StateLens observe()
  -> routeObservation()
  -> testing agent receives one of:
       skip_vision
       use_text_observation
       use_full_vision
  -> StateLens timeline attached to test report
```

The integration should be code-enforced where we control the runtime. Prompt policy is useful for closed clients, but it is not enough for reliable savings.

## Playwright Test Fixture

Add a Playwright Test fixture that wraps actions and captures observations.

Suggested file:

```text
src/adapters/playwrightTest.ts
```

Suggested usage:

```ts
import { test, expect } from './fixtures';

test('login failure shows error', async ({ page, lens }) => {
  await lens.step('navigate login', () => page.goto('/login'));

  await lens.step('submit bad password', async () => {
    await page.getByLabel('Email').fill('a@example.com');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
  });

  await expect(page.getByText('Invalid password')).toBeVisible();
});
```

Suggested fixture:

```ts
export const test = base.extend<{
  lens: StateLensTestFixture;
}>({
  lens: async ({ page }, use, testInfo) => {
    const lens = createStateLensTestFixture(page, {
      sessionId: testInfo.testId,
      attach: testInfo.attach.bind(testInfo),
    });

    await lens.prewarm();
    await use(lens);
    await lens.attachTimeline();
  },
});
```

## Fixture API

```ts
export interface StateLensTestFixture {
  prewarm(): Promise<void>;
  step<T>(actionLabel: string, fn: () => Promise<T>): Promise<T>;
  observe(actionLabel?: string): Promise<StateLensStepObservation>;
  timeline(): TimelineResult;
  attachTimeline(): Promise<void>;
}

export interface StateLensStepObservation {
  action_label: string;
  observation: ObservationResult;
  route: ObservationRoute;
}
```

Behavior:

1. `prewarm()` calls the pipeline prewarm hook.
2. `step(label, fn)` runs the action, then captures and routes a screenshot.
3. `observe(label)` captures and routes without performing an action.
4. `attachTimeline()` writes the timeline JSON into the Playwright test report.
5. The fixture should not call a downstream VLM directly. It should return routing decisions to the caller or agent harness.

## Healer Loop Integration

The healer loop is the highest-value path.

When a test fails:

```text
test failure
  -> capture current screenshot
  -> StateLens timeline since test start
  -> agent receives compact failure context
  -> agent proposes locator/wait/data fix
  -> rerun
```

Give the healer:

- failing assertion
- current `ObservationResult`
- StateLens timeline
- last N route decisions
- screenshots only for `use_full_vision` steps

Example healer context:

```json
{
  "failure": "Expected text 'Invalid password' to be visible",
  "last_observation": {
    "event_type": "text_appeared",
    "event_summary": "Text appeared: \"Required\"",
    "text_diff": {
      "added": ["Required"],
      "removed": []
    },
    "changed_regions": [
      { "label": "content area" }
    ]
  },
  "route": "use_text_observation"
}
```

This is cheaper than sending every screenshot from every retry to the agent.

## Agentic Test Report

Attach a StateLens report to Playwright output.

Suggested artifacts:

```text
test-results/<test>/statelens-timeline.json
test-results/<test>/statelens-routes.json
test-results/<test>/statelens-summary.md
```

Summary fields:

- total screenshots
- keyframes
- no-change frames
- minor-change frames
- full-vision routes
- text-observation routes
- estimated downstream screenshots avoided
- StateLens internal VLM usage
- final timeline

This gives StateLens an observability story, not just a cost story.

## Cost Model

StateLens saves money only when it prevents screenshots from reaching the downstream model.

In agentic testing, savings come from:

| Case | StateLens route | Savings |
|---|---|---|
| retry sees same error page | `skip_vision` | avoids repeated screenshot reasoning |
| form validation text appears | `use_text_observation` | sends text instead of pixels |
| minor animation/spinner shift | `skip_vision` | avoids noise |
| visual-only canvas/chart state | `use_full_vision` | no savings for that step, but timeline still helps |
| pipeline uncertainty | `use_full_vision` | conservative fallback |

The correct claim is:

> StateLens reduces screenshot/VLM usage during agentic testing loops while preserving full-vision fallback for uncertain visual states.

Do not claim universal savings on all Playwright tests. Standard Playwright snapshot flows are already efficient.

## Implementation Plan

### Step 0 - Freeze Pipeline

Run:

```bash
npm run build
npm test
```

Commit Phase 3 and any existing adapter work separately.

### Step 1 - Playwright Test Fixture

Implement:

```text
src/adapters/playwrightTest.ts
tests/adapters/playwrightTest.test.ts
```

Acceptance:

- fixture captures screenshots after actions
- fixture routes observations with `routeObservation()`
- unchanged recapture produces `skip_vision`
- text-sufficient keyframe produces `use_text_observation`
- `attachTimeline()` attaches valid JSON

### Step 2 - Failure Context Builder

Implement:

```text
src/adapters/testingFailureContext.ts
tests/adapters/testingFailureContext.test.ts
```

Acceptance:

- takes test failure metadata plus timeline
- emits compact Markdown and JSON contexts
- includes screenshots only for steps routed to `use_full_vision`
- includes StateLens VLM usage

### Step 3 - Demo Healer Loop

Implement:

```text
demo/agent_loop/playwright_healer_demo.ts
```

The demo can use a mocked downstream model first.

Flow:

1. run a deliberately brittle Playwright test
2. fail on changed UI text or locator
3. collect StateLens timeline
4. show the compact healer context
5. mock a patch recommendation
6. rerun or print the proposed fix

Acceptance:

- demonstrates repeated screenshots avoided
- prints route counts
- prints mock downstream VLM call count
- does not require a model API key for the default demo

### Step 4 - Optional Stagehand Adapter

Implement after Playwright fixture is stable.

Suggested file:

```text
src/adapters/stagehand.ts
```

Goal:

- wrap Stagehand page/session screenshot capture
- run StateLens before model-heavy observe/agent turns when possible
- attach route decisions to Stagehand or Browserbase session logs

Do not make Stagehand a required dependency. Use optional peer-style imports or adapter interfaces.

### Step 5 - Docs and Positioning

Add a README section:

```text
StateLens for Agentic Testing
```

Message:

- For normal Playwright tests, use selectors and accessibility snapshots.
- For screenshot-heavy agentic loops, StateLens reduces repeated VLM reasoning.
- Best first use case: healer/debug loops and visual fallback workflows.

## Product Packaging

Potential package paths:

```ts
import { createStateLensTestFixture } from 'statelens/playwright-test';
import { captureAndRoute } from 'statelens/playwright';
import { routeObservation } from 'statelens/adapters';
```

Keep the main `statelens` entrypoint focused on the pipeline. Adapters should be importable without forcing browser dependencies into core users.

## Non-Goals

- Do not replace Playwright locators.
- Do not replace Playwright accessibility snapshots.
- Do not claim savings for tests that never use screenshots or VLM calls.
- Do not require Playwright as a core dependency.
- Do not depend on Momentic internals.
- Do not build a full autonomous testing product in this phase.

## Risks

| Risk | Mitigation |
|---|---|
| Playwright snapshot flows already solve token cost | Position StateLens for screenshot-heavy fallback, visual UIs, and healer loops |
| Fixture adds too much latency | Prewarm OCR and allow sampling only after selected actions |
| Healer needs raw pixels for a visual bug | Route uncertain and visual-only states to `use_full_vision` |
| Browser dependencies bloat install | Keep Playwright and Stagehand optional |
| Savings are hard to prove | Add route counts and mocked downstream VLM call counts to demo output |

## Definition of Done

This feature is done when:

- A Playwright Test fixture wraps actions and records StateLens observations.
- A failure context builder emits compact healer-ready JSON/Markdown.
- A demo shows an agentic testing loop avoiding repeated screenshot/VLM calls.
- Test reports include StateLens timeline artifacts.
- The integration works without a model API key by default.
- Optional model/VLM paths still report honest usage.
- Core Phase 3 pipeline tests continue to pass.

