# Person B — Distribution & Demo Engineer

You own everything around the pipeline: the MCP server, the CLI, the measurement harness, the demo screenshots, the README, and the pitch. Person A delivers a pipeline library to you through a locked interface — you wrap it for the world.

You also own the **Anthropic console**: API key rotation, billing, model access.

## Files You Own

```
src/server.ts                ← MCP server (4 tools)
src/index.ts                 ← CLI: serve | run | measure
eval/measure_tokens.ts       ← PRIMARY DEMO ARTIFACT — the headline numbers
eval/results/                ← saved measurement runs
demo/screenshots/login_flow/ ← 14 PNGs you record
demo/screenshots/checkout_flow/ ← 2nd scenario you record
demo/run.ts                  ← batch CLI demo
README.md                    ← install/configure instructions
```

You also own pitch materials (slides, demo script) — keep them in `docs/pitch/` once you create that.

## Files You Do NOT Touch

- Anything in `src/pipeline/` — that's Person A's library
- `src/utils/image.ts` — Person A's
- `tests/pipeline/` — Person A writes their own tests

You consume Person A's pipeline only through the public exports of `src/pipeline/index.ts`. Do NOT reach into individual stage files.

## Integration Contract (Locked, Hour 1)

This is what you can rely on Person A delivering. The stub already implements these signatures so you're unblocked from hour zero.

```typescript
import {
  observe,
  getTimeline,
  resetSession,
  getVlmCumulativeUsage,
  resetVlmCumulativeUsage,
} from './pipeline/index.js';
```

Types: `ObservationResult`, `TimelineResult`, `ChangedRegion`, `TextDiff`, `VlmUsage`. All exported from `src/pipeline/index.ts`.

If you need a new export, request it from Person A — do not add to pipeline files yourself.

## Reference

`../DESIGN.md` — full design doc. Key sections for you:
- §3: MCP tool definitions (exact descriptions go on the tools)
- §5.1: MCP server skeleton
- §7.1: Token measurement harness spec
- §11: Evaluation methodology

Pin `DESIGN.md` as `@` context in every Cursor Composer session.

---

## Phase 1: Server & Screenshots (Hours 0–6)

**Goal:** MCP server discoverable in Cursor + 14 demo screenshots recorded.

### Tasks

1. **Hour 0** — `cd ~/statelens && npm install && npm run build`. Must succeed. Fix any TypeScript errors.
2. **Hour 0-1** — Verify `.env` has working `ANTHROPIC_API_KEY` (already done).
3. **Hour 1-3** — **Record 14 login-flow screenshots** into `demo/screenshots/login_flow/`. Use any login page (GitHub, your own product, a quick HTML mock). Match the sequence in `DESIGN.md` §7.3. Name them `001.png` through `014.png`.
4. **Hour 3-5** — Finish `src/server.ts`. The stub has all 4 tools wired but `statelens_compare` has a TODO. Polish that and verify Cursor discovers all 4 tools.
5. **Hour 5-6** — Add StateLens to your local Cursor MCP config and test tool discovery. Configure in `~/.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "statelens": {
         "command": "node",
         "args": ["/Users/midosang/statelens/dist/server.js"]
       }
     }
   }
   ```
   Restart Cursor. Open the MCP panel — you should see 4 tools.

### Phase 1 Cursor Prompts

**MCP server polish — src/server.ts**

```
@DESIGN.md

The MCP server skeleton in src/server.ts is mostly done. Two issues to fix:

1. statelens_compare currently calls observe() with a fake session ID. Per Section 3.3, it should be stateless and compare two screenshots directly. Add a dedicated compare() function to src/pipeline/index.ts (coordinate with Person A — propose this as a new export). If Person A isn't ready, inline a minimal compare flow in server.ts that calls visualGate + spatialDiff + ocrDiff directly, returning the same ObservationResult shape.

2. Add startup logging so we can see the server is alive when launched: console.error("StateLens MCP server v0.1.0 starting on stdio...") at the top of main(). Use console.error not console.log — stdout is for MCP protocol.

3. Add try/catch in each tool handler that returns a structured error response instead of throwing (MCP clients handle errors better when they're returned as content).

Acceptance: node dist/server.js boots without error; Cursor's MCP panel shows all 4 tools after config + restart.
```

**Demo screenshot recording**

No Cursor prompt — this is manual:

1. Open `demo/screenshots/login_flow/` in Finder
2. Pick a login page (any will do). The 14-step sequence:
   ```
   001.png  Page loads (blank login form)
   002.png  Cursor blinking in email field (minor change)
   003.png  Email partially typed
   004.png  Email fully typed
   005.png  Cursor in password field
   006.png  Password dots typed
   007.png  Submit button becomes enabled (color change)
   008.png  Click animation
   009.png  Loading spinner
   010.png  Error banner: "Invalid password"
   011.png  Cursor on "Forgot password" link
   012.png  Reset password modal opens
   013.png  Modal close animation
   014.png  Back to login page
   ```
3. Use Cmd+Shift+4 → spacebar → click window (Mac). Or just full-window Cmd+Shift+3.
4. Keep them at the same resolution (don't resize one and not others — pixelmatch needs same dimensions).
5. Save as PNG, sequential names.

Pro tip: if you can't find a real login flow that errors, build a 10-line HTML page with a form + a setTimeout that shows an error banner.

### Phase 1 Merge Checkpoint (Hour 6) — REQUIRED

Both of you stop and verify together:

1. `git pull origin main`
2. Person A demos: `node dist/demo/run.js demo/screenshots/login_flow` prints diffs
3. You demo: Cursor's MCP panel shows StateLens with 4 tools; test calling `statelens_observe` on a path
4. `npm test` passes
5. Decide together: any interface tweaks before Phase 2?
6. Both commit + push.

---

## Phase 2: Measurement Harness (Hours 6–14)

**Goal:** `npm run measure` produces real Anthropic API token deltas.

### Tasks

1. **Hour 6-11** — Implement `eval/measure_tokens.ts` per `DESIGN.md` §7.1 and §11. Use the Cursor prompt below. This is your most important deliverable.
2. **Hour 11-13** — Build a pretty terminal output (use `chalk` if you want — add to package.json deps). Output should match the table in §7.1.
3. **Hour 13-14** — Run `npm run measure` for the first time against Person A's real pipeline (which lands at end of Phase 2). Save the output to `eval/results/phase2_baseline.json`.

### Phase 2 Cursor Prompts

**Measurement harness — eval/measure_tokens.ts**

```
@DESIGN.md

Implement eval/measure_tokens.ts per Sections 7.1 and 11.

Structure:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import {
  observe, resetSession, getVlmCumulativeUsage, resetVlmCumulativeUsage
} from '../src/pipeline/index.js';

const MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
// Pricing (per 1M tokens), update if Anthropic changes prices:
const PRICING = {
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-haiku-4-5-20251001': { in: 0.80, out: 4.00 },
};
const SCREENSHOTS_DIR = './demo/screenshots/login_flow';
const PROMPT = 'Summarize what changed since the previous screenshot in one sentence.';

async function runBaseline(client, screenshots) {
  let inTok = 0, outTok = 0, calls = 0;
  const start = Date.now();
  for (const buf of screenshots) {
    const r = await client.messages.create({
      model: MODEL, max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') }},
        { type: 'text', text: PROMPT }
      ]}]
    });
    inTok += r.usage.input_tokens;
    outTok += r.usage.output_tokens;
    calls++;
  }
  return { calls, inTok, outTok, ms: Date.now() - start };
}

async function runStateLens(client, screenshots) {
  resetSession('eval'); resetVlmCumulativeUsage();
  let sonnetIn = 0, sonnetOut = 0, sonnetCalls = 0;
  const start = Date.now();
  for (const buf of screenshots) {
    const obs = await observe(buf, 'eval');
    if (!obs.changed) continue;
    if (obs.keyframe && !obs.vlm_called) {
      const r = await client.messages.create({
        model: MODEL, max_tokens: 200,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Screenshot event: ${obs.event_summary}` }]}]
      });
      sonnetIn += r.usage.input_tokens;
      sonnetOut += r.usage.output_tokens;
      sonnetCalls++;
    }
    // vlm_called: Haiku already ran inside observe(); accumulated via getVlmCumulativeUsage
  }
  const haiku = getVlmCumulativeUsage();
  return {
    sonnetCalls, sonnetIn, sonnetOut,
    haikuIn: haiku.input_tokens, haikuOut: haiku.output_tokens,
    ms: Date.now() - start
  };
}

function cost(tokens, perMillion) { return (tokens / 1_000_000) * perMillion; }

export async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set (check .env)');
    process.exit(1);
  }
  // Load .env if not already loaded:
  // (use dotenv or manual parse — keep it simple)

  const client = new Anthropic();
  const files = (await readdir(SCREENSHOTS_DIR))
    .filter(f => extname(f).toLowerCase() === '.png').sort();
  if (files.length === 0) { console.error('No screenshots in', SCREENSHOTS_DIR); process.exit(1); }
  const screenshots = await Promise.all(files.map(f => readFile(join(SCREENSHOTS_DIR, f))));

  console.log(`Running A/B measurement on ${screenshots.length} screenshots against ${MODEL}...`);
  console.log('');
  console.log('Run A — Baseline (raw images to Sonnet)...');
  const A = await runBaseline(client, screenshots);
  console.log('Run B — StateLens compression...');
  const B = await runStateLens(client, screenshots);

  // Compute costs and savings, print the §7.1 table, save JSON to eval/results/run_<ISO>.json
  // ... (implement printing per Section 7.1)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
```

Implement the printing/saving section to match the output format in DESIGN.md Section 7.1. Use chalk for color if you want — add it to package.json deps (small).

Acceptance: `npm run measure` runs end-to-end against real Anthropic API, prints the savings table, saves JSON to eval/results/. Two consecutive runs within 1% on token counts.
```

**Loading .env in Node**

```
@DESIGN.md

eval/measure_tokens.ts needs to read .env to get ANTHROPIC_API_KEY into process.env. Two options:
1. Add dotenv to deps and `import 'dotenv/config'` at the top
2. Manually parse .env

Pick option 1 (cleaner). Add dotenv ^16.4.5 to package.json dependencies. Import at the top of eval/measure_tokens.ts.

Also load .env in src/server.ts (so the Haiku calls inside Person A's vlmExplainer have ANTHROPIC_API_KEY available when called via MCP).
```

### Phase 2 Merge Checkpoint (Hour 14) — REQUIRED

The headline-number moment. **This is your demo evidence.**

1. `git pull origin main`
2. **Run `npm run measure` together with Person A.** Numbers must:
   - Sonnet input tokens in Run B << Run A
   - Run B totals INCLUDE Haiku tokens (verify by checking `getVlmCumulativeUsage()` is being added)
   - Reduction percentage between 60-90%
3. Save the output: `cp eval/results/run_*.json eval/results/phase2_baseline.json`
4. If savings <30%, debug together: usually the importance scorer is too aggressive (everything is a keyframe) or text-sufficient logic isn't kicking in.
5. Both commit + push.

---

## Phase 3: Polish & Demo (Hours 14–24)

**Goal:** Cursor live demo runs reliably. README is install-ready. Second scenario works.

### Tasks

1. **Hour 14-17** — Record second screenshot scenario into `demo/screenshots/checkout_flow/`. Pick a flow with different UI patterns (cart → checkout → payment → confirm).
2. **Hour 17-19** — Polish the live Cursor demo. Write `docs/DEMO_SCRIPT.md` with the exact prompt to paste into Cursor for the live walkthrough. Run it 3 times back-to-back, fix anything flaky.
3. **Hour 19-21** — Finalize `README.md`: install snippets for Cursor, Claude Code, Claude Desktop. Architecture diagram. Quickstart. Run `npm run measure` link.
4. **Hour 21-24** — Annotated diff images: extend `src/index.ts` `run` command to optionally save PNGs with bounding boxes drawn around changed regions (use sharp + svg overlay). High-impact for slides.

### Phase 3 Merge Checkpoint (Hour 24) — REQUIRED

1. Drive 3 back-to-back live demos in Cursor. All must succeed.
2. `npm run measure` against both scenarios — save to `eval/results/`.
3. README renders cleanly on github.com — visit the repo page and check.
4. Both commit + push.

---

## Phase 4: Stretch (Hours 24–40)

Pick from `DESIGN.md` §15. Your best targets as Person B:

1. **Live Playwright agent integration** (highest impact): a real browser automation script that uses StateLens MCP via a local agent loop. Shows StateLens working on live screenshots, not prerecorded. See `DESIGN.md` Hour 30-40 in §8.
2. **HTML report**: generate a session report with embedded before/after thumbnails and timeline. Linkable, demo-able.
3. **Cost calculator endpoint**: a `statelens_estimate` tool that takes a session length and returns projected savings.

### Phase 4 Merge Checkpoint (Hour 40) — REQUIRED

Stretch features integrated cleanly. If something is half-finished and breaking the demo, revert it.

---

## Phase 5: Pitch (Hours 40–48)

You're the pitch driver. Person A is your technical backstop.

### Tasks

1. **Hour 40-43** — Slides per `DESIGN.md` §12.3 (2-minute pitch):
   - Slide 1: Problem (CUA agents waste tokens on redundant screenshots)
   - Slide 2: Existing solutions are model-internal (ReVision comparison)
   - Slide 3: StateLens is model-external middleware (architecture diagram)
   - Slide 4: **Measurement results** — your `npm run measure` table (THIS IS THE PROOF)
   - Slide 5: Live demo (Cursor with StateLens MCP)
   - Slide 6: Roadmap (hosted version, benchmark validation)
2. **Hour 43-45** — Record a backup demo video in case live demo fails. OBS or QuickTime screen recording. ~90 seconds.
3. **Hour 45-47** — Practice the pitch 5+ times. Time yourself. Stay under 2 minutes.
4. **Hour 47-48** — Final repo polish: clean commit history, ensure README badges (npm version, license, build status) render.

---

## Daily Discipline

- Pin `DESIGN.md` and this doc as `@` context in every Cursor Composer session
- `npm run build && npm test` before every push
- `git pull` before `git push`
- Never modify `src/pipeline/` files — those are Person A's
- Anthropic console hygiene: monitor spend in https://console.anthropic.com/settings/usage. Hackathon should cost <$5 total. If you see anything weird, rotate the key.
- After hackathon: rotate the API key (it was pasted in chat once)
