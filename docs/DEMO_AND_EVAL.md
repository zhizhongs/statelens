# Demo And Evaluation

This file keeps the demo, measurement, and reproduction paths out of the public README. The README should explain how to use StateLens; this doc explains how to prove it works and how to run the demo assets in this repo.

## Live Computer-Use Demo

Run the computer-use-style agent loop. It drives a browser, captures fresh screenshots after each action, routes them through StateLens, and prints the saved-token estimate at the end.

```bash
npm run build
npm run demo:computer-use
```

The demo requires Playwright:

```bash
npm install --save-dev playwright
npx playwright install chromium
```

The reference implementation is at:

```text
demo/agent_loop/playwright_login.ts
```

At the end it reports route-level downstream savings and StateLens timeline accounting: `vlm_calls_saved`, `reduction_pct`, and `estimated_tokens_saved`.

## Folder Replay Demo

Folder replay is useful for MCP clients and regression checks.

Prompt for an MCP-capable agent:

```text
Use statelens_observe to walk through the screenshots in ./demo/screenshots/login_flow/
and tell me what happened.
```

The agent calls `statelens_observe` for each frame. StateLens filters redundant frames, extracts text diffs, and returns structured events. Only frames with meaningful visual-only changes trigger an internal VLM call.

## Live Evaluation

Run the full `RESULTS.md`-style evaluation from a fresh live capture instead of checked-in screenshot folders:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run build
npm run eval:live
```

This captures the login flow on the fly, runs the same A/B efficiency harness as `npm run measure`, then runs the Haiku accuracy judge.

Output files:

```text
eval/results/live_login_*.json
eval/results/live_login_*.accuracy.json
```

Use this when you only want the efficiency run:

```bash
npm run eval:live -- --no-accuracy
```

## Measuring Savings

The repo ships with an A/B harness that runs the same screenshot task twice against the Anthropic API:

- Run A: raw screenshots through Sonnet.
- Run B: screenshots routed through StateLens, with honest accounting for internal Haiku calls.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run measure
```

Run against checkout:

```bash
npm run measure -- demo/screenshots/checkout_flow
```

## Headline Results

Measured on two scenarios, real Anthropic API token counts, baseline = raw screenshots through Sonnet with a fair "what changed" prompt (prev + curr image to Sonnet per frame):

| Scenario | Frames | Token reduction | Cost reduction | Accuracy (lenient) | Accuracy (strict) |
|---|---:|---:|---:|---:|---:|
| Login (GitHub sign-in -> 2FA -> dashboard) | 12 | 81.9% | 90.1% | 100.0% | 81.8% |
| Checkout (Zara cart -> shipping -> payment) | 10 | 69.9% | 81.2% | 77.8% | 33.3% |

Accuracy is judged by Claude Haiku against the raw-image baseline: does StateLens's compressed signal describe the same UI event? `skipped` frames count as agreement; the first frame of each session is excluded.

Full per-frame verdicts live under:

```text
eval/results/phase4_*.accuracy.json
```

## Login Example Output

```text
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
  Sonnet image tokens: 100%  (12 image calls -> 0)
```

Token counts come directly from `response.usage.input_tokens` in the Anthropic API responses. Run B includes Haiku tokens consumed inside StateLens.

## Source Checkout Commands

```bash
npm install
npm run dev          # tsc --watch
npm test             # vitest run
npm run build        # production build to ./dist
```
