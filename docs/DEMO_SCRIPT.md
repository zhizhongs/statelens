# Live Demo Script — Cursor + StateLens

This is the exact flow to run during the pitch. Two parts: numbers first (slide), live MCP demo second (Cursor window).

## Part 1 — Headline Numbers (Slide)

Show the table from `eval/results/phase3_baseline.json`. Lead with the cost reduction.

```
Task: 12-frame login flow analysis  •  Model: claude-sonnet-4-6
─────────────────────────────────────────────────────────────────
Baseline (raw images)           StateLens compression
  12 API calls                    3 Sonnet text + 4 Haiku vision
  19,008 input tokens             5,353 input tokens
  $0.0640                         $0.0138
─────────────────────────────────────────────────────────────────
  → 78% cost reduction, 72% input-token reduction
  → 5 of 12 frames filtered entirely (zero AI calls)
```

Talking points (15 seconds):

> "These numbers come from the Anthropic API itself — `response.usage.input_tokens`. We ran the same 12-screenshot task twice against Claude Sonnet, once sending raw images, once routed through StateLens. The savings include Haiku tokens consumed inside StateLens — we count those against ourselves so this isn't a 'shifted to a cheaper model' trick. Real numbers, reproducible: `npm run measure`."

## Part 2 — Live MCP Demo in Cursor

**Pre-flight (do BEFORE the pitch starts):**

1. Cursor is running and StateLens MCP server is connected
   - `~/.cursor/mcp.json` has `statelens` entry pointing at `dist/src/server.js`
   - Cursor Settings → MCP panel shows `statelens` with green dot and 4 tools
2. `eval/results/phase3_baseline.json` is open in a side panel (for the numbers slide)
3. `demo/screenshots/login_flow/` has all 12 frames
4. The Cursor agent chat is open (`Cmd+L`)

**The exact prompt to paste:**

```
Use the statelens_observe tool to walk through every PNG in /Users/midosang/statelens/demo/screenshots/login_flow/
in filename order. Call statelens_observe once per file with session_id "live_demo".
Then call statelens_timeline with session_id "live_demo" and summarize the events
in 3-5 bullet points. Do not read the images directly with the Read tool — use
statelens_observe so the image bytes don't enter your context.
```

**What should happen:**

- Cursor's agent calls `statelens_observe` 12 times, you see each one in the tool-call panel
- Some calls return `changed: false` (skipped frames)
- Most return structured events with text diffs
- Final `statelens_timeline` call returns the full session summary
- Cursor produces a natural-language summary like:
  > "The user opened the login page, typed credentials, hit submit, got an 'Invalid password' error, opened the reset modal, then closed it."

**Talking points during the demo (~45 seconds):**

> "Watch Cursor discover the four StateLens tools — zero custom integration. For each screenshot it calls `statelens_observe`. StateLens runs locally: perceptual hashing, pixel diff, OCR on cropped regions. It returns text. The image bytes never enter Cursor's reasoning context. After 12 calls, `statelens_timeline` gives us a structured event log. Cursor's summary is built from text, not pixels."

## Stress Test (Phase 5 — Before Pitch Only)

Run the demo prompt above 3 times back-to-back with `statelens_reset` between each. All three runs must produce a coherent summary. If any run produces gibberish or fails a tool call, debug before going on stage:

- **Cursor doesn't call `statelens_observe`** → re-prompt explicitly. If still failing, check MCP panel for connection status.
- **Tool call errors** → check `console.error` output. Most likely cause: dimension mismatch between screenshots, or missing ANTHROPIC_API_KEY in MCP env block.
- **Final summary is wrong** → the importance scorer may be missing keyframes. Run `npm run measure` and inspect `eval/results/run_*.json` per-frame to see what each frame got classified as.

## Backup Plan

If the live demo breaks during the pitch:
1. Don't panic — switch to the recording at `docs/demo_recording.mov` (record this in Phase 5).
2. Or show `npm run measure` running in a terminal — the harness produces the same value proposition without depending on Cursor.

The harness is your safety net. The Cursor demo is the showpiece.
