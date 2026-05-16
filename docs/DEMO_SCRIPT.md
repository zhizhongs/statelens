# Live Demo Script — Cursor + StateLens

This is the exact flow to run during the pitch. Two parts: live full evaluation for numbers, route demo second (Cursor window).

## Part 1 — Headline Numbers (Slide)

Show the table from `RESULTS.md`, or run the live evaluation below and show the saved `eval/results/live_login_*.json` plus `*.accuracy.json` files. Lead with the cost reduction and lenient accuracy.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run build
npm run eval:live
```

This captures fresh login-flow screenshots, runs the A/B efficiency harness, runs the Haiku accuracy judge, and writes the same schema used by `RESULTS.md`.

```
Task: live computer-use login flow  •  Model: claude-sonnet-4-6
─────────────────────────────────────────────────────────────────
Baseline (raw images)           StateLens compression
  raw screenshot calls            text observations + selected Haiku vision
  response.usage tokens           response.usage tokens
  baseline cost                   compressed cost
─────────────────────────────────────────────────────────────────
  → token reduction, cost reduction, strict accuracy, lenient accuracy
  → saved under eval/results/live_login_*.json
```

Talking points (15 seconds):

> "These numbers come from the Anthropic API itself — `response.usage.input_tokens`. We capture the live flow, run it twice against Claude Sonnet, once sending raw images and once routed through StateLens. The savings include Haiku tokens consumed inside StateLens — we count those against ourselves so this isn't a 'shifted to a cheaper model' trick. Real numbers, reproducible: `npm run eval:live`."

## Part 2 — Live Computer-Use Demo in Cursor

**Pre-flight (do BEFORE the pitch starts):**

1. Cursor is running in the repo.
2. Dependencies are ready:
   - `npm install`
   - `npm install --save-dev playwright`
   - `npx playwright install chromium`
3. The repo builds cleanly with `npm run build`.
4. `RESULTS.md` or the latest `eval/results/live_login_*.json` is open in a side panel for the headline numbers.
5. The Cursor agent chat is open (`Cmd+L`).

**The exact prompt to paste:**

```
We are doing the StateLens live computer-use demo. Do not replay demo/screenshots.
Run:

npm run build
npm run demo:computer-use

Then summarize the final "Live StateLens session summary" in 3-5 bullets.
Include the downstream full screenshot calls avoided, estimated input tokens saved,
pipeline VLM calls saved, and pipeline estimated tokens saved.
```

For the full `RESULTS.md`-style run in Cursor, paste this instead:

```
Run the StateLens live full evaluation. Do not replay demo/screenshots.
Run:

npm run build
npm run eval:live

Then summarize the saved efficiency JSON and accuracy JSON paths, token reduction,
cost reduction, strict accuracy, and lenient accuracy.
```

**What should happen:**

- Cursor runs the live demo from inside the repo, rather than walking a screenshot directory.
- The demo launches a headless browser, drives a login flow, and captures screenshots after each action.
- Each fresh screenshot is passed through the in-process StateLens adapter.
- The terminal shows route decisions: `SKIP`, `TEXT`, or `VISION`.
- The final block reports:
  - screenshots captured on the fly
  - downstream full screenshot calls avoided
  - estimated downstream input tokens saved
  - StateLens internal VLM calls made
  - pipeline VLM calls saved
  - pipeline estimated tokens saved

**Talking points during the demo (~45 seconds):**

> "This is no longer a folder replay. Cursor is running a computer-use-style agent loop: action, screenshot, StateLens observe, route. The browser screenshots are captured on the fly. StateLens decides whether the downstream agent gets nothing, a compact text observation, or the full screenshot. At the end we report the thing judges care about: how many screenshot calls we avoided and how many input tokens that saved."

**Optional MCP variant for closed-client integration:**

If you specifically want to show Cursor discovering the MCP tools, keep StateLens
registered in Cursor and use this prompt after the live demo:

```text
Use statelens_observe with screenshot_base64 for each current screenshot you capture
during a short login flow. Do not walk demo/screenshots. Use one session_id,
pass an action_label after each action, then call statelens_timeline and report
estimated_tokens_saved.
```

This is best-effort because closed clients control their own screenshot loop.
The in-process demo above is the reliable proof path.

## Stress Test (Phase 5 — Before Pitch Only)

Run `npm run demo:computer-use` 3 times back-to-back. All three runs must produce route logs and a final savings block. If any run fails, debug before going on stage:

- **Playwright missing** → run `npm install --save-dev playwright` and `npx playwright install chromium`.
- **No final savings block** → check that `npm run build` succeeded and that Cursor ran `npm run demo:computer-use`, not the old folder prompt.
- **Final summary is wrong** → the importance scorer may be missing keyframes. Run `npm run eval:live` and inspect `eval/results/live_login_*.json` per-frame to see what each frame got classified as.

## Backup Plan

If the live demo breaks during the pitch:
1. Don't panic — switch to the recording at `docs/demo_recording.mov` (record this in Phase 5).
2. Or show `npm run eval:live` running in a terminal — the harness produces the same value proposition without depending on Cursor.
3. Or use the folder replay prompt with `demo/screenshots/login_flow/` as a fallback; label it clearly as replay mode.

The harness is your safety net. The Cursor demo is the showpiece.
