# StateLens: Screenshot Gateway for UI Agents

## Current Architecture and Proxy Roadmap

## 1. Project Summary

StateLens compresses UI screenshot streams into semantic state changes before an agent spends expensive vision tokens. The current product ships as an open-source MCP (Model Context Protocol) server, a TypeScript pipeline library, and in-process routing helpers. The next product surface is a local SDK/proxy gateway that applies the same pipeline transparently to model API requests.

Current computer-use agents operate in a loop:

```
screenshot -> VLM reasons over full image -> action -> new screenshot -> VLM reasons again
```

Most consecutive screenshots are visually identical. The agent wastes tokens rediscovering unchanged UI regions.

StateLens inserts a compression layer before the reasoning model:

```
screenshot -> StateLens pipeline -> { route, event_summary, text_diff } -> skip image, send text, or forward full vision
```

The core pipeline is unchanged across delivery surfaces. What changes is the interception point:

| Surface | Status | Interception point |
|---|---|---|
| MCP server | Built | Agent voluntarily calls `statelens_observe` before vision reasoning |
| In-process adapter | Built | Developer calls `observe()` / `routeObservation()` inside their agent loop |
| SDK middleware | Planned | Wrapper intercepts `client.messages.create()` in-process |
| Local API proxy/gateway | Planned | SDK sends `POST /v1/messages` to StateLens via `ANTHROPIC_BASE_URL` |

The MCP behavior is not deprecated. It remains the right path for tool-aware clients and demos. The gateway path exists because MCP cannot force a closed or semi-closed agent loop to consult a tool before sending screenshots to its model.

### How It Works for the End User Today: MCP

```bash
npm install -g statelens
```

Claude Code config (`~/.claude/mcp.json`):

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

Claude Code (or Cursor, Windsurf, etc.) now discovers StateLens tools automatically. When the AI agent encounters screenshot-heavy workflows, it calls `statelens_observe` before deciding whether to spend tokens on full image reasoning.

### How It Works Next: Local Gateway

For SDK-based agents, the user runs a local gateway and points the SDK at it:

```bash
statelens proxy --provider anthropic --port 8443
export ANTHROPIC_BASE_URL=http://localhost:8443
```

The SDK still calls `client.messages.create(...)`. The request lands at StateLens first. If it contains screenshot image blocks, the gateway runs the same pipeline and applies a conservative routing policy:

- `use_full_vision`: forward the request unchanged
- `use_text_observation`: remove image blocks and inject a StateLens text observation
- `skip_vision`: remove image blocks and inject "no meaningful UI change" context, then forward as text-only
- `analysis_error` / `invalid_screenshot`: forward unchanged

The default gateway does not man-in-the-middle arbitrary traffic and does not require custom CA certificates. It only works when the SDK or agent exposes a base URL / endpoint override.

### What Claude Code Sees

Once configured, Claude Code has access to these tools:

```
statelens_observe     — compare a screenshot against the previous one, get structured diff
statelens_timeline    — get the full session event log
statelens_compare     — compare any two screenshots directly
statelens_reset       — clear session state
```

Example interaction in Claude Code:

```
Human: automate logging into example.com and report what happens

Claude: [takes screenshot] Let me check what changed.
        [calls statelens_observe with screenshot path]

StateLens returns: { changed: false }

Claude: Nothing changed since the last screenshot, skipping analysis.
        [types credentials, takes another screenshot]
        [calls statelens_observe]

StateLens returns: {
  changed: true,
  keyframe: true,
  event_summary: "Red error banner appeared: Invalid password",
  text_diff: { added: ["Invalid password"] }
}

Claude: The login failed with "Invalid password". Let me try the alternate credentials.
```

Claude made zero VLM image-analysis calls. It got the state change as structured text from StateLens.

## 2. Competitive Landscape and Positioning

### 2.1 What Exists Today

The problem of visual redundancy in UI agents is well studied. Five recent papers attack it directly:

1. **ReVision** (Microsoft Research + UBC, May 2026): Learned patch selector (3-layer MLP) that compares patch embeddings across consecutive screenshots and drops redundant tokens. Trained on OmniParserV2 region labels. 46% token reduction, +3% success rate on OSWorld/WebTailBench/AgentNetBench. Requires fine-tuning Qwen2.5-VL-7B on filtered trajectories.

2. **HistPrune-GUI** (March 2026): Empirical study showing GUI agents exhibit a recency effect, background regions capture state transitions, and random pruning preserves spatial structure better than careful strategies.

3. **Spatio-Temporal Token Pruning** (February 2026): Identifies fading memory attention patterns and spatial topology conflicts from unstructured pruning.

4. **ShowUI** (CVPR 2025): Treats screenshots as connected graphs for intra-frame token selection. 33% token reduction, 1.4x training speedup.

5. **ExeVRM**: Temporal token pruning for video reward models. Suppresses unchanged tokens across frames for reward assessment.

### 2.2 The Gap We Fill

Every existing approach is **model-internal**. They modify the token stream inside a specific VLM architecture and require fine-tuning. This means:

- ReVision works for Qwen2.5-VL-7B. Anthropic cannot use it for Claude computer use. OpenAI cannot use it for Operator. Each provider must independently build and train their own version.
- The compression is invisible. Developers cannot inspect what was kept or dropped, cannot debug agent failures from state transitions, and get no observability.
- Integration requires modifying model internals. There is no install path for end users.

StateLens is **model-external**. It runs before the model call, not inside the model architecture. In the current implementation, that means an MCP server or in-process routing helper. In the gateway implementation, that means request middleware in front of Anthropic/OpenAI-compatible APIs. It works with any downstream model whose screenshots pass through one of those surfaces. It produces human-readable output developers can inspect.

### 2.3 Positioning Statement

ReVision answers: "How do we make Qwen see fewer redundant patches?"

StateLens answers: "How does any developer, using any UI agent stack they can configure, avoid paying for screenshots that did not change?"

We are not competing on internal token efficiency. We are building the **screenshot gate** outside the model: first as MCP and in-process adapters, next as SDK middleware and a local API gateway.

### 2.4 Why MCP Stays, and Why Gateway Comes Next

MCP is still valuable. It is the protocol that Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Continue, and Zed use for tool discovery. A developer who installs an MCP server gets the same StateLens tools in every MCP-aware client. This is the lowest-friction way to expose semantic screenshot observations to tool-calling agents.

But MCP is an opt-in side channel. The agent has to decide to call `statelens_observe`. If the agent's screenshot loop is closed, prompt-controlled, or buried inside a framework, the MCP server cannot force itself into the model-request path.

The gateway surface fixes that for SDK-based agents. Anthropic-compatible SDKs expose a `baseURL` / `ANTHROPIC_BASE_URL` configuration path. OpenAI-compatible SDKs expose similar endpoint overrides. A local StateLens gateway can receive the model request, inspect image content blocks, run the pipeline, rewrite the request when safe, and forward it upstream. No MCP tool call is required from the agent.

This creates an honest three-tier integration story:

| Tier | Integration | StateLens surface |
|---|---|---|
| 1 | Developer controls the agent loop | In-process adapter or MCP tool call |
| 2 | SDK-based agent with configurable endpoint | SDK middleware or local API gateway |
| 3 | Fully hosted closed agent with no hooks | Out of scope unless the vendor adds an integration point |

## 3. MCP Tool Definitions

### 3.1 statelens_observe

The primary tool. Compares the current screenshot against the previous one in the session and returns a structured diff.

```typescript
{
  name: "statelens_observe",
  description: "Analyze a UI screenshot for changes since the last observation. Returns structured diff including whether anything changed, what text appeared/disappeared, where the change occurred, and a semantic event summary. Call this before sending a screenshot to your reasoning model to avoid wasting tokens on unchanged screens. Provide exactly one of screenshot_path or screenshot_base64.",
  inputSchema: {
    type: "object",
    properties: {
      screenshot_path: {
        type: "string",
        description: "Absolute path to the screenshot image file (PNG or JPEG). Mutually exclusive with screenshot_base64."
      },
      screenshot_base64: {
        type: "string",
        description: "Base64-encoded screenshot bytes (PNG or JPEG). Use when the agent holds the screenshot in memory and does not want to write a temp file. A 'data:image/...;base64,' prefix is tolerated. Mutually exclusive with screenshot_path."
      },
      mime_type: {
        type: "string",
        enum: ["image/png", "image/jpeg"],
        description: "Optional MIME type hint for screenshot_base64. Informational only; sharp auto-detects the actual format."
      },
      session_id: {
        type: "string",
        description: "Session identifier to track state across observations. Defaults to 'default'.",
        default: "default"
      },
      action_label: {
        type: "string",
        description: "Optional label for the action that preceded this screenshot (e.g. 'click_submit', 'type_email')"
      }
    },
    // No "required": []; validation in the handler ensures exactly one of
    // screenshot_path / screenshot_base64 is provided.
  }
}
```

**Input contract:** the handler accepts either `screenshot_path` or `screenshot_base64`, never both, never neither. Supplying both or neither returns a validation error. `screenshot_path` is preserved for local tools and existing demos; `screenshot_base64` is the in-memory path for agents that capture screenshots without touching disk. See `docs/POST_PHASE3_AGENT_INTEGRATION.md` for the integration rationale.

**Response:**

```json
{
  "changed": true,
  "keyframe": true,
  "importance_score": 0.87,
  "event_type": "error_appeared",
  "event_summary": "Red error banner appeared: Invalid password",
  "changed_regions": [
    {"x": 120, "y": 80, "w": 400, "h": 60, "label": "top-center banner"}
  ],
  "text_diff": {
    "added": ["Invalid password"],
    "removed": []
  },
  "vlm_called": false,
  "latency_ms": 34
}
```

### 3.2 statelens_timeline

Returns the full session event log with cost metrics.

```typescript
{
  name: "statelens_timeline",
  description: "Get the semantic timeline of all UI state changes detected in a session. Includes cost savings metrics and event summaries.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Session identifier. Defaults to 'default'.",
        default: "default"
      }
    }
  }
}
```

**Response:**

```json
{
  "session_id": "default",
  "total_screenshots": 14,
  "keyframes": 7,
  "vlm_calls_made": 2,
  "vlm_calls_saved": 12,
  "reduction_pct": 85.7,
  "estimated_tokens_saved": 14400,
  "events": [
    {
      "step": 1,
      "event_type": "page_loaded",
      "summary": "Login page loaded with email and password fields",
      "text_diff": {"added": ["Email", "Password", "Sign in"], "removed": []},
      "vlm_used": false
    },
    {
      "step": 5,
      "event_type": "error_appeared",
      "summary": "Red error banner appeared: Invalid password",
      "text_diff": {"added": ["Invalid password"], "removed": []},
      "vlm_used": false
    }
  ]
}
```

### 3.3 statelens_compare

Direct comparison of any two screenshots. Useful outside a session context.

```typescript
{
  name: "statelens_compare",
  description: "Compare two screenshots directly and return the structured diff between them. Does not require a session.",
  inputSchema: {
    type: "object",
    properties: {
      before_path: {
        type: "string",
        description: "Path to the earlier screenshot"
      },
      after_path: {
        type: "string",
        description: "Path to the later screenshot"
      }
    },
    required: ["before_path", "after_path"]
  }
}
```

### 3.4 statelens_reset

Clear session state to start fresh.

```typescript
{
  name: "statelens_reset",
  description: "Reset a session, clearing all stored state and timeline events.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        default: "default"
      }
    }
  }
}
```

## 4. System Architecture

### 4.1 Pipeline Overview

The core pipeline is identical regardless of whether StateLens is consumed as an MCP server, a library adapter, SDK middleware, or a local API gateway. Each surface is a thin wrapper around the same `observe()` function.

```
Input surface
  - MCP Tool Call (statelens_observe)
  - In-process adapter call
  - Planned SDK middleware / proxy request
       |
       v
[Stage 1] Cheap Visual Gate          <-- pHash + pixelmatch, <5ms, no GPU
       |
       | (if similar: return {changed: false})
       v
[Stage 2] Spatial Diff Localization  <-- pixel diff + bounding boxes, <10ms
       |
       v
[Stage 3] OCR Text Diff             <-- tesseract.js on changed regions, <200ms
       |
       v
[Stage 4] Importance Scorer          <-- rule-based: text_change + visual_change + region_size
       |
       | (if score < threshold: return summary from text diff alone)
       v
[Stage 5] Selective VLM Explainer    <-- only for high-importance, text-insufficient keyframes
       |
       v
[Stage 6] Timeline Assembly          <-- merge into session event log
       |
       v
Structured observation or rewritten model request
```

### 4.2 Stage 1: Cheap Visual Gate

**Purpose:** Kill obviously redundant frames before any expensive processing.

**Implementation (TypeScript):**
```typescript
import { createHash } from 'crypto';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

interface GateResult {
  changed: boolean;
  gate: string;
  distance?: number;
  diffPixels?: number;
  diffPercent?: number;
}

async function visualGate(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  diffThreshold: number = 0.02 // 2% of pixels changed
): Promise<GateResult> {
  // Resize both to standard dimensions for comparison
  const width = 640;
  const height = 360;

  const prev = await sharp(prevBuffer).resize(width, height).raw().toBuffer();
  const curr = await sharp(currBuffer).resize(width, height).raw().toBuffer();

  // Fast hash comparison first
  const prevHash = createHash('md5').update(prev).digest('hex');
  const currHash = createHash('md5').update(curr).digest('hex');

  if (prevHash === currHash) {
    return { changed: false, gate: 'hash_exact', distance: 0 };
  }

  // Pixelmatch for near-duplicates
  const diff = Buffer.alloc(width * height * 4);
  const numDiffPixels = pixelmatch(
    prev, curr, diff,
    width, height,
    { threshold: 0.1 }
  );

  const diffPercent = numDiffPixels / (width * height);

  if (diffPercent < diffThreshold) {
    return { changed: false, gate: 'pixelmatch', diffPercent };
  }

  return { changed: true, gate: 'passed', diffPixels: numDiffPixels, diffPercent };
}
```

**Expected kill rate:** 30-40% of frames filtered here based on ReVision's measured 36-56% temporal redundancy across benchmarks.

**Latency:** <5ms per pair. No GPU.

### 4.3 Stage 2: Spatial Diff Localization

**Purpose:** Find bounding boxes around changed regions.

**Implementation (TypeScript):**
```typescript
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

interface ChangedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

async function spatialDiff(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  minArea: number = 500
): Promise<ChangedRegion[]> {
  const { width, height } = await sharp(currBuffer).metadata();
  const prev = await sharp(prevBuffer).raw().toBuffer();
  const curr = await sharp(currBuffer).raw().toBuffer();

  const diff = Buffer.alloc(width * height * 4);
  pixelmatch(prev, curr, diff, width, height, { threshold: 0.1 });

  // Scan diff image for changed regions using connected component analysis
  // Find bounding boxes of contiguous changed pixel clusters
  const regions = findBoundingBoxes(diff, width, height, minArea);

  return regions.map(r => ({
    ...r,
    label: classifyRegion(r, width, height)
  }));
}

function classifyRegion(
  region: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number
): string {
  const centerX = region.x + region.w / 2;
  const centerY = region.y + region.h / 2;
  const relX = centerX / imgW;
  const relY = centerY / imgH;
  const area = (region.w * region.h) / (imgW * imgH);

  if (area > 0.3 && relX > 0.2 && relX < 0.8 && relY > 0.2 && relY < 0.8)
    return 'center modal';
  if (relY < 0.15) return 'top banner';
  if (relY > 0.85) return 'bottom bar';
  if (relX < 0.25) return 'left sidebar';
  if (relX > 0.75) return 'right panel';
  return 'content area';
}
```

**Latency:** <10ms. pixelmatch already computed the diff image in Stage 1; Stage 2 reuses it.

### 4.4 Stage 3: OCR Text Diff

**Purpose:** Detect text that appeared or disappeared. Highest-signal cheapest tool for UI state changes.

**Implementation (TypeScript):**
```typescript
import Tesseract from 'tesseract.js';
import sharp from 'sharp';

let worker: Tesseract.Worker | null = null;

async function getWorker(): Promise<Tesseract.Worker> {
  if (!worker) {
    worker = await Tesseract.createWorker('eng');
  }
  return worker;
}

interface TextDiff {
  added: string[];
  removed: string[];
}

async function ocrDiff(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  regions: ChangedRegion[]
): Promise<TextDiff> {
  const w = await getWorker();

  const prevTexts = new Set<string>();
  const currTexts = new Set<string>();

  for (const region of regions) {
    // Crop changed region from both screenshots
    const cropOpts = {
      left: region.x,
      top: region.y,
      width: region.w,
      height: region.h
    };

    const prevCrop = await sharp(prevBuffer).extract(cropOpts).toBuffer();
    const currCrop = await sharp(currBuffer).extract(cropOpts).toBuffer();

    const prevResult = await w.recognize(prevCrop);
    const currResult = await w.recognize(currCrop);

    // Split into lines and clean
    const prevLines = prevResult.data.text.split('\n').map(s => s.trim()).filter(Boolean);
    const currLines = currResult.data.text.split('\n').map(s => s.trim()).filter(Boolean);

    prevLines.forEach(l => prevTexts.add(l));
    currLines.forEach(l => currTexts.add(l));
  }

  const added = [...currTexts].filter(t => !prevTexts.has(t));
  const removed = [...prevTexts].filter(t => !currTexts.has(t));

  return { added, removed };
}
```

**Key optimization:** OCR only on changed region crops from Stage 2, not the full screenshot. A 400x60px banner crop is 50x cheaper than a 1920x1080 full frame.

**Latency:** <200ms on region crops. First call ~2s due to tesseract.js WASM init (pre-warm on server start).

### 4.5 Stage 4: Importance Scorer

**Purpose:** Decide whether a change is worth a VLM call or whether the text diff alone is sufficient.

```typescript
interface ScoreResult {
  score: number;
  textSufficient: boolean;
  shouldCallVlm: boolean;
}

function importanceScore(
  regions: ChangedRegion[],
  textDiff: TextDiff,
  imgW: number,
  imgH: number
): ScoreResult {
  let score = 0;

  // Text changes are high signal
  if (textDiff.added.length > 0) {
    score += 0.4;

    const allText = textDiff.added.join(' ').toLowerCase();
    const errorKeywords = ['error', 'invalid', 'failed', 'denied', 'warning', 'required'];
    if (errorKeywords.some(kw => allText.includes(kw))) {
      score += 0.2;
    }
  }

  // Large changed regions suggest layout/modal changes
  const totalArea = regions.reduce((sum, r) => sum + r.w * r.h, 0);
  const screenArea = imgW * imgH;
  if (totalArea > 0.1 * screenArea) {
    score += 0.3;
  }

  // Center-screen regions suggest modals
  if (regions.some(r => r.label === 'center modal')) {
    score += 0.1;
  }

  const textSufficient = textDiff.added.length > 0 && score < 0.7;
  const shouldCallVlm = score > 0.5 && !textSufficient;

  return { score, textSufficient, shouldCallVlm };
}
```

**Decision logic:**
- score < 0.3: minor change, not a keyframe, skip
- score >= 0.3 and text explains it: keyframe, return text-based summary, no VLM
- score >= 0.5 and text is empty: keyframe, call VLM for explanation

### 4.6 Stage 5: Selective VLM Explainer

**Purpose:** Generate a semantic description only for keyframes where text diff is insufficient.

**When called:**
- High importance score AND no meaningful text diff (visual-only changes)
- Modal/overlay appeared with no extractable text
- Layout shifted significantly
- Button state change (color only)

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function vlmExplain(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  regions: ChangedRegion[]
): Promise<{ eventType: string; summary: string; importantText: string[] }> {
  const prevBase64 = prevBuffer.toString('base64');
  const currBase64 = currBuffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: prevBase64 }
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: currBase64 }
        },
        {
          type: 'text',
          text: `You are analyzing two consecutive UI screenshots.
Describe only the meaningful UI state change in one sentence.
Changed region: ${JSON.stringify(regions)}

Focus on: error messages, modals, button state changes, form changes, navigation, content loading, layout shifts.

Return JSON only:
{
  "event_type": "short_snake_case",
  "summary": "one concise sentence",
  "important_text": ["key visible text"]
}`
        }
      ]
    }]
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}
```

**Model choice:** Haiku for cost. This call is rare (10-20% of frames) and cheap (~$0.0003 per call with two small images).

### 4.7 Stage 6: Timeline Assembly

```typescript
interface TimelineEvent {
  step: number;
  eventType: string;
  summary: string;
  textDiff: TextDiff;
  regions: ChangedRegion[];
  vlmUsed: boolean;
}

class SessionTimeline {
  sessionId: string;
  events: TimelineEvent[] = [];
  totalScreenshots = 0;
  vlmCalls = 0;
  private prevScreenshot: Buffer | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  getPrevScreenshot(): Buffer | null {
    return this.prevScreenshot;
  }

  setPrevScreenshot(buf: Buffer) {
    this.prevScreenshot = buf;
  }

  addEvent(event: TimelineEvent) {
    this.events.push(event);
    if (event.vlmUsed) this.vlmCalls++;
  }

  incrementTotal() {
    this.totalScreenshots++;
  }

  getTimeline() {
    return {
      session_id: this.sessionId,
      total_screenshots: this.totalScreenshots,
      keyframes: this.events.length,
      vlm_calls_made: this.vlmCalls,
      vlm_calls_saved: this.totalScreenshots - this.vlmCalls,
      reduction_pct: this.totalScreenshots > 0
        ? Math.round((1 - this.vlmCalls / this.totalScreenshots) * 1000) / 10
        : 0,
      estimated_tokens_saved: (this.totalScreenshots - this.vlmCalls) * 1200,
      events: this.events
    };
  }
}
```

## 5. MCP Server Implementation

### 5.1 Server Entry Point

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { observe, getTimeline, compare, resetSession } from './pipeline/index.js';

const server = new McpServer({
  name: 'statelens',
  version: '0.1.0',
  description: 'Compress UI screenshot streams into semantic state changes'
});

server.tool(
  'statelens_observe',
  'Analyze a UI screenshot for changes since the last observation. Returns structured diff with text changes, spatial regions, and semantic event summary.',
  {
    screenshot_path: z.string().describe('Absolute path to screenshot (PNG/JPEG)'),
    session_id: z.string().default('default').describe('Session ID for tracking state'),
    action_label: z.string().optional().describe('Label for the preceding action')
  },
  async ({ screenshot_path, session_id, action_label }) => {
    const buffer = await readFile(screenshot_path);
    const result = await observe(buffer, session_id, action_label);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }
);

server.tool(
  'statelens_timeline',
  'Get the full semantic timeline of UI state changes for a session, including cost savings metrics.',
  {
    session_id: z.string().default('default')
  },
  async ({ session_id }) => {
    const timeline = getTimeline(session_id);
    return {
      content: [{ type: 'text', text: JSON.stringify(timeline, null, 2) }]
    };
  }
);

server.tool(
  'statelens_compare',
  'Compare two screenshots directly. Returns structured diff. No session required.',
  {
    before_path: z.string().describe('Path to the earlier screenshot'),
    after_path: z.string().describe('Path to the later screenshot')
  },
  async ({ before_path, after_path }) => {
    const before = await readFile(before_path);
    const after = await readFile(after_path);
    const result = await compare(before, after);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }
);

server.tool(
  'statelens_reset',
  'Reset a session, clearing stored state and timeline.',
  {
    session_id: z.string().default('default')
  },
  async ({ session_id }) => {
    resetSession(session_id);
    return {
      content: [{ type: 'text', text: `Session "${session_id}" reset.` }]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
```

### 5.2 Pipeline Orchestrator

```typescript
// pipeline/index.ts

import { visualGate } from './visualGate.js';
import { spatialDiff } from './spatialDiff.js';
import { ocrDiff } from './ocrDiff.js';
import { importanceScore } from './importanceScorer.js';
import { vlmExplain } from './vlmExplainer.js';
import { SessionTimeline } from './timeline.js';

const sessions = new Map<string, SessionTimeline>();

function getSession(id: string): SessionTimeline {
  if (!sessions.has(id)) {
    sessions.set(id, new SessionTimeline(id));
  }
  return sessions.get(id)!;
}

export async function observe(
  screenshotBuffer: Buffer,
  sessionId: string = 'default',
  actionLabel?: string
) {
  const start = Date.now();
  const session = getSession(sessionId);
  session.incrementTotal();

  const prev = session.getPrevScreenshot();
  session.setPrevScreenshot(screenshotBuffer);

  // First screenshot in session
  if (!prev) {
    return {
      changed: true,
      keyframe: true,
      importance_score: 1.0,
      event_type: 'session_start',
      event_summary: 'First screenshot captured',
      changed_regions: [],
      text_diff: { added: [], removed: [] },
      vlm_called: false,
      latency_ms: Date.now() - start
    };
  }

  // Stage 1: Cheap visual gate
  const gate = await visualGate(prev, screenshotBuffer);
  if (!gate.changed) {
    return {
      changed: false,
      keyframe: false,
      importance_score: 0,
      event_type: 'no_change',
      event_summary: 'No meaningful UI change detected',
      changed_regions: [],
      text_diff: { added: [], removed: [] },
      vlm_called: false,
      latency_ms: Date.now() - start
    };
  }

  // Stage 2: Spatial diff
  const regions = await spatialDiff(prev, screenshotBuffer);

  // Stage 3: OCR text diff
  const textDiff = regions.length > 0
    ? await ocrDiff(prev, screenshotBuffer, regions)
    : { added: [], removed: [] };

  // Stage 4: Importance scoring
  const { width, height } = await getImageDimensions(screenshotBuffer);
  const scoring = importanceScore(regions, textDiff, width, height);

  // Low importance: not a keyframe
  if (scoring.score < 0.3) {
    return {
      changed: true,
      keyframe: false,
      importance_score: scoring.score,
      event_type: 'minor_change',
      event_summary: 'Minor visual change, not significant',
      changed_regions: regions,
      text_diff: textDiff,
      vlm_called: false,
      latency_ms: Date.now() - start
    };
  }

  let eventType: string;
  let eventSummary: string;
  let vlmCalled = false;

  if (scoring.textSufficient) {
    // Stage 4 path: text diff explains the change
    eventType = inferEventType(textDiff);
    eventSummary = buildTextSummary(textDiff, regions);
  } else if (scoring.shouldCallVlm) {
    // Stage 5: VLM needed
    const vlmResult = await vlmExplain(prev, screenshotBuffer, regions);
    eventType = vlmResult.eventType;
    eventSummary = vlmResult.summary;
    vlmCalled = true;
  } else {
    eventType = 'ui_change';
    eventSummary = `UI changed in ${regions.map(r => r.label).join(', ')}`;
  }

  // Stage 6: Add to timeline
  session.addEvent({
    step: session.totalScreenshots,
    eventType,
    summary: eventSummary,
    textDiff,
    regions,
    vlmUsed: vlmCalled
  });

  return {
    changed: true,
    keyframe: true,
    importance_score: scoring.score,
    event_type: eventType,
    event_summary: eventSummary,
    changed_regions: regions,
    text_diff: textDiff,
    vlm_called: vlmCalled,
    latency_ms: Date.now() - start
  };
}

export function getTimeline(sessionId: string) {
  return getSession(sessionId).getTimeline();
}

export async function compare(before: Buffer, after: Buffer) {
  return observe(after, `compare_${Date.now()}`);
}

export function resetSession(sessionId: string) {
  sessions.delete(sessionId);
}
```

### 5.3 Shared Routing Contract

All delivery surfaces use the same pipeline and route decision. MCP returns the raw `ObservationResult` because the agent is responsible for deciding how to use the tool result. In-process adapters and the planned gateway additionally call `routeObservation()` to turn the observation into a model-request policy.

```typescript
type ObservationRoute =
  | { route: 'skip_vision'; reason: string; observation: ObservationResult }
  | { route: 'use_text_observation'; context: string; observation: ObservationResult }
  | { route: 'use_full_vision'; reason: string; observation: ObservationResult };
```

Gateway policy:

| Route | Default gateway behavior | Why |
|---|---|---|
| `use_full_vision` | Forward the original request unchanged | Preserve accuracy on first frames, failures, and visual-only states |
| `use_text_observation` | Strip screenshot image blocks and inject StateLens text context | Preserve model reasoning while avoiding image tokens |
| `skip_vision` | Strip screenshot image blocks and inject no-change context, then forward text-only | Let the agent maintain loop continuity without paying for pixels |
| `analysis_error` / `invalid_screenshot` | Forward unchanged | Fail open rather than silently losing state |

Hard short-circuiting, where StateLens returns a synthesized model response without forwarding upstream, is an opt-in optimization for deterministic loops. It is not the default because generic agents may rely on each model turn for planning, tool calls, or conversation state.

### 5.4 Planned SDK Middleware

The lowest-friction Tier 2 product is an in-process SDK wrapper. It avoids a network hop, avoids TLS questions, and works for applications that instantiate their model client directly.

Target Anthropic shape:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from 'statelens/anthropic';

const client = wrapAnthropic(new Anthropic(), {
  sessionId: 'checkout-flow',
});

await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 512,
  messages,
});
```

Wrapper behavior:

1. Intercept `messages.create()`.
2. Detect image content blocks in the request body.
3. Decode screenshot bytes from base64 data URLs or provider-native image source fields.
4. Call `observe(buffer, sessionId, actionLabel)`.
5. Call `routeObservation(observation)`.
6. Rewrite the request according to the routing table above.
7. Delegate to the real SDK client.

The wrapper must preserve SDK behavior outside screenshot-bearing requests: streaming, retries, headers, beta flags, tool definitions, system prompts, and non-image messages should pass through unchanged.

### 5.5 Planned Local API Gateway

The gateway version is for agents or binaries that do not expose their SDK instance but do let the user override the API endpoint.

Detailed implementation spec: `docs/PROXY_IMPLEMENTATION.md`.

Target CLI:

```bash
statelens proxy --provider anthropic --port 8443
export ANTHROPIC_BASE_URL=http://localhost:8443
```

Target endpoint coverage:

```text
GET  /health
POST /v1/messages              Anthropic-compatible request rewriting
GET  /sessions/:id/timeline    StateLens timeline/debug endpoint
POST /sessions/:id/reset       Clear gateway session state
```

Future provider endpoints:

```text
POST /v1/chat/completions      OpenAI-compatible request rewriting
POST /responses                OpenAI Responses API request rewriting
```

Anthropic request flow:

```
SDK client
  |
  | POST /v1/messages
  v
StateLens gateway
  |
  | parse JSON body
  | find messages[].content[] image blocks
  | run observe() on latest screenshot
  | routeObservation()
  | rewrite body or fail open
  v
api.anthropic.com/v1/messages
  |
  v
gateway returns upstream response to SDK
```

Provider-specific request rewriting:

- Preserve `model`, `max_tokens`, `temperature`, `tools`, `tool_choice`, `system`, `metadata`, and beta fields.
- Preserve all non-screenshot text/tool content blocks in order.
- Remove only the screenshot image block(s) selected for gating.
- Append a text content block after the surrounding user content:

```text
StateLens observation for the latest UI screenshot:
Event: error_appeared
Summary: Red error banner appeared: Invalid password
Text appeared: "Invalid password"
Regions changed: top banner

Use this observation instead of re-reading the removed screenshot unless the task explicitly requires raw visual inspection.
```

Session identity:

- Prefer explicit `x-statelens-session-id` header when present.
- Otherwise derive a process-local session from provider, API key hash prefix, and request conversation shape.
- Expose `STATELENS_SESSION_ID` for simple single-session demos.
- Never send StateLens session metadata upstream unless the provider request already included user metadata and the user opted in.

Internal VLM calls:

- StateLens's own Haiku / small-VLM calls must bypass the gateway to avoid recursion.
- The internal client should use the real upstream base URL explicitly, ignoring `ANTHROPIC_BASE_URL` when `STATELENS_UPSTREAM_ANTHROPIC_BASE_URL` is set.
- Gateway accounting must include internal VLM usage in timeline and savings metrics, matching the existing measurement harness.

Streaming:

- MVP supports non-streaming requests first.
- Streaming pass-through is allowed when no rewrite is needed.
- For rewritten streaming requests, the gateway can forward the rewritten request upstream with `stream: true` and pipe the provider event stream back unchanged.
- Synthetic short-circuit streaming is deferred; it is only needed for opt-in hard-skip mode.

Security and privacy:

- No transparent MITM.
- No custom CA installation.
- Local HTTP is acceptable for localhost development; remote/team deployment must use HTTPS.
- Do not log raw screenshots by default.
- Log route decisions, token estimates, latency, and event summaries.
- Provide `STATELENS_LOG_IMAGES=1` only for explicit debugging.

Implementation modules:

```text
src/gateway/
  requestRouting.ts       provider-neutral route policy
  imageBlocks.ts          extract/remove image blocks from provider payloads
  session.ts              gateway session identity and timeline lookup
src/middleware/
  anthropic.ts            wrapAnthropic(client, options)
src/proxy/
  anthropic.ts            local HTTP handler for /v1/messages
```

The gateway must not change the MCP server's tool definitions or behavior. It imports the same pipeline and adapter helpers; it does not replace `src/server.ts`.

## 6. Code Architecture

```
statelens/
├── src/
│   ├── index.ts                 # CLI entry: serve | run <dir> | measure | proxy (planned)
│   ├── server.ts                # MCP server: tool definitions + handlers
│   ├── pipeline/
│   │   ├── index.ts             # Pipeline orchestrator: observe(), getTimeline()
│   │   ├── visualGate.ts        # Stage 1: hash + pixelmatch
│   │   ├── spatialDiff.ts       # Stage 2: bounding boxes from diff image
│   │   ├── ocrDiff.ts           # Stage 3: tesseract.js on changed regions
│   │   ├── importanceScorer.ts  # Stage 4: rule-based scoring
│   │   ├── vlmExplainer.ts      # Stage 5: Haiku VLM call (instrumented for usage)
│   │   └── timeline.ts          # Stage 6: session event assembly
│   ├── adapters/                # Post-Phase-3 in-process integration layer
│   │   ├── routeObservation.ts  # Maps ObservationResult → skip/text/vision route
│   │   └── playwright.ts        # captureAndRoute(): Playwright-shaped reference adapter
│   ├── gateway/                 # Planned provider-neutral request rewriting layer
│   │   ├── requestRouting.ts    # ObservationRoute → provider payload policy
│   │   ├── imageBlocks.ts       # Extract/remove image blocks from SDK/API payloads
│   │   └── session.ts           # Gateway session identity
│   ├── middleware/              # Planned in-process SDK wrappers
│   │   └── anthropic.ts         # wrapAnthropic(client, options)
│   ├── proxy/                   # Planned local HTTP gateways
│   │   └── anthropic.ts         # Anthropic-compatible /v1/messages proxy
│   └── utils/
│       └── image.ts             # Sharp helpers: resize, crop, dimensions
├── eval/
│   ├── measure_tokens.ts        # PRIMARY DEMO: A/B token measurement harness
│   └── results/                 # Per-run JSON outputs for the slide chart
├── demo/
│   ├── screenshots/
│   │   ├── login_flow/          # 14 frames (primary demo)
│   │   └── checkout_flow/       # Second scenario
│   ├── agent_loop/
│   │   └── playwright_login.ts  # Reference agent loop using the adapter
│   └── run.ts                   # Batch CLI processor
├── tests/
│   ├── pipeline/                # Unit tests per stage
│   └── adapters/                # Router + Playwright adapter tests
├── package.json
├── tsconfig.json
└── README.md
```

### Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "pixelmatch": "^6.0.0",
    "sharp": "^0.33.0",
    "tesseract.js": "^5.0.0",
    "zod": "^3.23.0"
  },
  "bin": {
    "statelens": "./dist/index.js"
  }
}
```

### CLI Entry Point

```typescript
// src/index.ts
#!/usr/bin/env node

const command = process.argv[2];

if (command === 'serve') {
  // Start MCP server on stdio
  import('./server.js').then(m => m.main());
} else if (command === 'proxy') {
  // Planned: start local HTTP gateway for SDK baseURL integration
  import('./proxy/anthropic.js').then(m => m.main());
} else if (command === 'run') {
  // Batch process a screenshot directory
  const dir = process.argv[3];
  import('./demo/run.js').then(m => m.processDirectory(dir));
} else {
  console.log('Usage:');
  console.log('  statelens serve        Start MCP server (stdio)');
  console.log('  statelens proxy        Start local API gateway (planned)');
  console.log('  statelens run <dir>    Process a screenshot directory');
}
```

## 7. Demo Scenario

The demo has two parts. The **primary demo** is an empirical measurement script that proves the savings claim with real Anthropic API token counts. The **secondary demo** is a live MCP integration in Cursor (or Claude Code) showing zero-config tool discovery. Open with the numbers, close with the live integration.

### 7.1 Primary Demo: Empirical Token Measurement (Required)

**Goal:** Prove "we saved tokens" with actual `usage.input_tokens` from the Anthropic API, not estimates from assumed image-token costs.

The harness at `eval/measure_tokens.ts` runs the same screenshot-driven task twice against `claude-sonnet-4-6` and reports the delta. Both runs see the same 14 screenshots, the same prompts, the same model. The only difference is whether StateLens compression is in the loop.

**Run A — Baseline:** for each screenshot, send the raw image as `{type: 'image', ...}` content to Claude with the prompt "Summarize what changed in one sentence." Accumulate `response.usage.input_tokens` and `output_tokens`.

**Run B — StateLens:** for each screenshot, call `pipeline.observe(buffer)` first.
- `changed: false` → skip, zero API calls
- `keyframe: true && vlm_called: false` → send only `event_summary` as text to Claude (tiny payload)
- `vlm_called: true` → Haiku inside StateLens already ran; count its tokens too (the `vlmExplainer` module exposes a `getCumulativeUsage()` accessor so we honestly include the cost we incurred)

**Expected output:**

```
Task: 14-frame login flow analysis
Model: claude-sonnet-4-6 (StateLens internal: claude-haiku-4-5)

Run A (baseline, raw images):
  API calls:           14
  Input tokens:        16,847
  Output tokens:       1,203
  Wall time:           28.4s
  Estimated cost:      $0.0589

Run B (StateLens compression):
  Claude API calls:    4    (2 text-only summaries + 2 visual keyframes)
  Haiku calls (inside): 2
  Input tokens (total): 3,720
  Output tokens:       412
  Wall time:           2.6s
  Estimated cost:      $0.0093

Savings:
  Token reduction: 77.9%
  Cost reduction:  84.2%
  Latency reduction: 90.8%
```

This output becomes the headline slide. Judges can `npm run measure` themselves to reproduce it — that is the verification. Token counts come from the API response, not our model.

### 7.2 Secondary Demo: Live MCP Integration (Cursor or Claude Code)

After the numbers are on screen, switch to a Cursor (or Claude Code) window where StateLens is registered as an MCP server. Walk through a conversation showing the editor's agent discovering and calling the StateLens tools without any custom integration.

**Setup:** StateLens MCP server configured in Cursor's MCP settings or Claude Code's `~/.claude/mcp.json`. The 14-frame login flow at `./demo/screenshots/login_flow/`.

**Demo conversation:**

```
Human: I have 14 screenshots from a browser run in ./demo/screenshots/login_flow/.
       Walk through them and tell me what happened. Use statelens_observe for each
       one instead of reading the images directly.

Agent: [calls statelens_observe for 001.png]
       → { changed: true, keyframe: true, event_summary: "Login page loaded" }

       [calls statelens_observe for 002.png]
       → { changed: false }   // cursor blink, skip

       ...continues through all 14, calling statelens_timeline at the end...

       Here's what happened:
       1. Login page loaded
       2. Email field filled
       3. Password field filled
       4. Submit button became active
       5. Error banner: "Invalid password"
       6. Reset password modal opened
       7. Modal closed, returned to login

       StateLens processed 14 screenshots, identified 7 keyframes, made
       2 internal VLM calls. The image bytes never entered my context.
```

**Why this demo works:** judges see zero-config integration with a real editor agent. The conversation IS the integration. No custom UI built.

**Note:** the "use statelens_observe instead of reading directly" instruction is intentional — without it, the agent might `Read` images, defeating the savings. This pattern (or a `CLAUDE.md` / `.cursorrules` directive) is exactly what end users would adopt to dogfood StateLens in their own workflows.

### 7.3 Prerecorded Screenshot Sequence

```
001.png  Login page loads (blank form)
002.png  Cursor blink in email field
003.png  Email partially typed
004.png  Email fully typed
005.png  Cursor in password field
006.png  Password dots typed
007.png  Submit button color changes (enabled)
008.png  Click animation on submit
009.png  Loading spinner
010.png  Error banner: "Invalid password"
011.png  Cursor on "Forgot password" link
012.png  Reset password modal opens
013.png  Modal close animation
014.png  Back to login page
```

### 7.4 Expected Metrics

```
Raw screenshots processed: 14
Keyframes detected: 7
VLM calls made: 2 (button state change + modal open)
VLM calls saved: 12
Reduction: 85.7%
Estimated tokens saved: 14,400
Avg pipeline latency: 47ms per frame
```

### 7.5 Cost Comparison

```
Without StateLens:
  14 VLM calls x ~1200 tokens each = 16,800 input tokens
  Estimated cost: $0.084 (at $5/M input tokens)
  Estimated latency: 14 x 2s = 28s of VLM wait time

With StateLens:
  2 VLM calls (Haiku) + 14 local diff calls = ~2,400 input tokens
  Estimated cost: $0.005
  Estimated latency: 14 x 47ms + 2 x 1s = 2.66s
  Savings: 94% cost, 90% latency
```

## 8. 48 Hour Hackathon Roadmap

### Hour 0-2: Project Setup and Demo Data

**Goal:** TypeScript project building, MCP SDK wired, demo screenshots ready.

Tasks:
1. `npm init`, install dependencies (sharp, pixelmatch, tesseract.js, @modelcontextprotocol/sdk, @anthropic-ai/sdk, zod)
2. Set up tsconfig, build script
3. Record or create 14 login flow screenshots
4. Write expected timeline manually as ground truth
5. Scaffold MCP server with one dummy tool to verify it connects to Claude Code

Deliverable: `statelens serve` runs, Claude Code sees a dummy tool, screenshots folder ready.

### Hour 2-6: Core Pipeline (Stages 1-3)

**Goal:** Screenshots go in, structured diffs come out, no VLM calls yet.

Tasks:
1. Implement visual gate (hash + pixelmatch)
2. Implement spatial diff with bounding boxes from pixelmatch diff image
3. Implement OCR text diff with tesseract.js on cropped regions
4. Wire into `observe()` orchestrator function
5. Test with `statelens run ./demo/screenshots/`

Deliverable: CLI that processes the screenshot folder and outputs which frames changed, where, and what text appeared/disappeared.

### Hour 6-10: Importance Scoring and Selective VLM (Stages 4-5)

**Goal:** Intelligent keyframe selection, VLM called only when text diff is insufficient.

Tasks:
1. Implement importance scorer with rule-based logic
2. Implement VLM explainer using Haiku
3. Wire scoring into pipeline: text-sufficient path vs VLM path
4. Test on demo sequence, verify VLM is called on only 2-3 frames

Deliverable: Full pipeline producing semantic events. `statelens run` shows VLM call count.

### Hour 10-14: MCP Server, Timeline, and Measurement Harness

**Goal:** StateLens works as an MCP server in Cursor/Claude Code AND the token measurement harness produces real numbers.

Tasks:
1. Wire `observe()` and `getTimeline()` into MCP tool handlers
2. Implement session state management (in-memory Map)
3. Implement `statelens_compare` and `statelens_reset` tools
4. Add to Cursor's MCP config (and Claude Code's), verify tool discovery
5. **Build `eval/measure_tokens.ts`** — A/B harness per Section 7.1
6. Instrument `vlmExplainer` to track cumulative Haiku usage so Run B accounting is honest
7. Run the harness end-to-end, save baseline numbers to `eval/results/`

Deliverable: Cursor discovers StateLens tools AND `npm run measure` outputs the headline savings table.

### Hour 14-20: Demo Polish and Second Scenario

**Goal:** Demo is reliable and generalizes.

Tasks:
1. Run the full Claude Code demo conversation 3+ times, fix edge cases
2. Record a second screenshot sequence (checkout flow or search results)
3. Test second scenario through the pipeline
4. Add cost metrics to timeline output
5. Handle error cases (missing file, corrupt image, empty session)

Deliverable: Two working demo flows, stable MCP server.

### Hour 20-30: Enhanced Demo and CLI Output

**Goal:** Make the output visually compelling for the pitch.

Tasks:
1. Build `statelens run` CLI output with colored terminal formatting (before/after comparison, highlighted text diffs, metrics summary)
2. Add diff image output: save annotated screenshots with bounding boxes drawn around changed regions
3. Add a `statelens report <session_id>` command that generates a markdown report with embedded image links
4. Optional: simple HTML report with screenshot thumbnails and timeline

Deliverable: `statelens run` produces compelling visual output. Annotated diff images saved alongside results.

### Hour 30-40: Live Agent Integration (Stretch)

**Goal:** Show StateLens working with a real browser agent, not just prerecorded screenshots.

Tasks:
1. Set up Playwright browser automation script for the login flow
2. Take a screenshot after each action, feed to `statelens_observe`
3. Agent uses StateLens response to decide next action without VLM image calls
4. Log the full session, show timeline at the end
5. Compare: same task with and without StateLens

Deliverable: Live browser automation demo where StateLens is compressing observations in real time.

### Hour 40-48: Pitch and Final Polish

**Goal:** Pitch-ready.

Tasks:
1. Prepare 2-minute pitch script
2. Build slides: problem, competitive landscape (ReVision comparison), live demo, industrial vision
3. Test demo end-to-end 5+ times
4. Record backup demo video in case live demo fails
5. Clean up README with install instructions, architecture diagram, usage examples
6. Add project branding

Deliverable: Working demo + polished pitch + clean GitHub repo.

## 9. Division of Labor (2 Person Team, Cursor-Driven)

The repo splits into two non-overlapping vertical columns. **Person A** owns the pipeline library. **Person B** owns everything that wraps it (MCP server, CLI, measurement harness, demo, pitch). They integrate at a single function signature locked in hour one.

This split minimizes merge conflicts (different directories), keeps both people writing code (not one coding + one slide-making), and lets Person B build the measurement harness in parallel against Person A's stub.

### 9.1 Vertical Split

**Person A — Pipeline Engineer**

Owns the entire `src/pipeline/` directory and `tests/pipeline/`.

Files:
- `src/pipeline/visualGate.ts` (Stage 1)
- `src/pipeline/spatialDiff.ts` (Stage 2)
- `src/pipeline/ocrDiff.ts` (Stage 3)
- `src/pipeline/importanceScorer.ts` (Stage 4)
- `src/pipeline/vlmExplainer.ts` (Stage 5) — exposes `getCumulativeUsage()` for the harness
- `src/pipeline/timeline.ts` (Stage 6)
- `src/pipeline/index.ts` — orchestrator: `observe()`, `getTimeline()`, `resetSession()`
- `src/utils/image.ts`
- `tests/pipeline/*.test.ts`

Person A delivers a pure TypeScript library. No HTTP, no MCP, no demo scripts. Just: pass in a Buffer, get back an Observation. They can work end-to-end without ever touching the MCP SDK.

**Person B — Distribution & Demo Engineer**

Owns everything around the pipeline.

Files:
- `src/server.ts` — MCP server + tool definitions
- `src/index.ts` — CLI: `serve`, `run`, `measure`
- `eval/measure_tokens.ts` — **the primary demo artifact**
- `demo/screenshots/login_flow/` — recording the 14 frames
- `demo/screenshots/checkout_flow/` — second scenario
- `demo/run.ts` — batch CLI demo
- `README.md` — install instructions, Cursor + Claude Code MCP config snippets
- Pitch slides + script
- Second demo scenario recording

### 9.2 Integration Contract (Day 1, Hour 1)

The seam between Person A and Person B is one function signature. Lock it in hour 1 and commit a stub immediately so Person B is unblocked:

```typescript
// src/pipeline/index.ts (Person A's interface)
export async function observe(
  screenshotBuffer: Buffer,
  sessionId?: string,
  actionLabel?: string
): Promise<ObservationResult>;

export function getTimeline(sessionId: string): TimelineResult;
export function resetSession(sessionId: string): void;

// Also exposed for the measurement harness (Person B's concern):
export function getVlmCumulativeUsage(): { input_tokens: number; output_tokens: number };
```

Person A's hour-1 deliverable is a stub that returns hardcoded `{changed: true, keyframe: true, ...}`. Person B starts building the MCP server and measurement harness immediately against the stub. By hour 6 Person A's real pipeline replaces the stub with no API changes.

### 9.3 Working With Cursor

Cursor's Composer (Cmd+I → agent mode) is the primary code-writing tool. A few patterns that pay off in a 48h sprint:

1. **Pin the design doc as `@` context in every Composer session.** Drag `statelens_mcp_hackathon_design_doc.md` into the chat. Cursor will reference Section 4.X for stage specs and Section 5.1 for the MCP server skeleton.
2. **One stage per Composer session.** Don't ask Cursor to "build the whole pipeline." Ask for one file at a time. Tight scope = reviewable diff.
3. **Immediately ask for tests.** Right after Cursor produces `spatialDiff.ts`, follow up: "now write `tests/pipeline/spatialDiff.test.ts` with 4 cases: no change, single region, multi-region, full-screen change." Catches bugs while the design is fresh.
4. **Dogfood your own MCP server in Cursor.** Once Person B has a basic `statelens serve` working, add it to Cursor's MCP config (`~/.cursor/mcp.json`) and use Cursor to test itself. Tool errors surface immediately in the right-side panel.
5. **Review diffs before "Apply".** Cursor's agent edits multiple files. Skim every change before accepting. Five seconds of review saves a 10-minute debug session.
6. **Use Cmd+L (chat) for "why does this fail" questions, Cmd+I (Composer) for "implement this".** Don't mix modes.

### 9.4 Cursor Prompt Playbook

Copy-paste these into Cursor Composer (agent mode). Replace `@spec` with the dragged-in design doc.

**Hour 1 — Both: Project scaffold**
```
@spec

Bootstrap a TypeScript Node project at the repo root following Section 6.

- Run npm init -y, install dependencies from Section 10
- Create tsconfig.json (strict, ES2022, NodeNext modules, outDir ./dist)
- Create the directory structure exactly as Section 6 specifies
- Add npm scripts: build (tsc), serve (node dist/server.js), measure (node dist/eval/measure_tokens.js), test (vitest)
- Create stub files for every .ts file in the tree, each exporting a placeholder

Acceptance: npm run build succeeds with empty stubs. Both people can cd into their files and start working.
```

**Person A — Stage 1: visualGate.ts**
```
@spec

Implement src/pipeline/visualGate.ts per Section 4.2.

Interface:
  async function visualGate(prevBuffer: Buffer, currBuffer: Buffer): Promise<GateResult>

GateResult: { changed: boolean, gate: string, distance?: number, diffPixels?: number, diffPercent?: number }

Implementation:
- Use sharp to resize both buffers to 640x360 raw RGBA
- MD5 hash both; if identical return {changed: false, gate: 'hash_exact'}
- Otherwise run pixelmatch with threshold 0.1
- If diffPercent < 0.02 return {changed: false, gate: 'pixelmatch', diffPercent}
- Else return {changed: true, gate: 'passed', diffPixels, diffPercent}

Also export the shared ChangedRegion type: { x, y, w, h, label }.

Acceptance: compiles strict TS, identical-buffer case under 5ms, zero GPU/network deps.
```

**Person A — Stage 3: ocrDiff.ts**
```
@spec

Implement src/pipeline/ocrDiff.ts per Section 4.4.

Interface:
  async function ocrDiff(prev: Buffer, curr: Buffer, regions: ChangedRegion[]): Promise<{added: string[], removed: string[]}>

Implementation:
- Lazy-init a singleton tesseract.js worker on first call (English)
- For each region: sharp.extract() the crop from both buffers, OCR both
- Split text into trimmed non-empty lines, collect into Sets per buffer
- Return setDiff: added = curr - prev, removed = prev - curr

Critical: never OCR the full screenshot. Only crops. The whole point of Stage 2 is to give us small regions.

Acceptance: pre-warmed second call under 200ms on a 400x60 banner crop; handles 0-region case (returns empty diff).
```

**Person A — Stage 5: vlmExplainer.ts (with usage instrumentation)**
```
@spec

Implement src/pipeline/vlmExplainer.ts per Section 4.6.

Interface:
  async function vlmExplain(prev: Buffer, curr: Buffer, regions: ChangedRegion[]): Promise<{eventType: string, summary: string, importantText: string[]}>

  function getCumulativeUsage(): { input_tokens: number, output_tokens: number }
  function resetCumulativeUsage(): void

Use @anthropic-ai/sdk with claude-haiku-4-5-20251001. Use the prompt from Section 10 / Section 4.6.

CRITICAL: maintain a module-level cumulative usage counter. After every API call, add response.usage.input_tokens and output_tokens to it. The measurement harness in eval/ depends on this for honest accounting — it lets us include Haiku cost in StateLens's totals so we can't be accused of just shifting tokens to a cheaper model.

Acceptance: returns parsed JSON event; getCumulativeUsage reflects every call.
```

**Person B — MCP server: server.ts**
```
@spec

Implement src/server.ts per Section 5.1.

Use @modelcontextprotocol/sdk McpServer + StdioServerTransport. Register four tools matching Section 3:
- statelens_observe(screenshot_path, session_id?, action_label?)
- statelens_timeline(session_id?)
- statelens_compare(before_path, after_path)
- statelens_reset(session_id?)

Each tool reads files via fs/promises and calls the matching function exported from src/pipeline/index.ts. Tool descriptions: use the EXACT strings from Section 3 — those descriptions guide the model's tool-selection behavior, do not paraphrase.

Acceptance: `node dist/server.js` starts an MCP server on stdio. Manually verify by adding to ~/.cursor/mcp.json and confirming the four tools appear in Cursor's MCP panel.
```

**Person B — Measurement harness: eval/measure_tokens.ts**
```
@spec

Implement eval/measure_tokens.ts per Sections 7.1 and 11.

This is the primary demo artifact. It runs a screenshot task twice against the Anthropic API and reports actual token deltas.

Setup:
- Load all PNG files from demo/screenshots/login_flow/ in filename order
- Use @anthropic-ai/sdk with claude-sonnet-4-6 (flag-configurable)

Run A — Baseline (raw images to Claude):
  For each screenshot:
    anthropic.messages.create({
      model, max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: toBase64(buf) } },
        { type: 'text', text: 'Summarize what changed since the previous screenshot in one sentence.' }
      ]}]
    })
  Accumulate response.usage.input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens.

Run B — StateLens compression:
  Import { observe, getVlmCumulativeUsage, resetSession } from '../src/pipeline/index.js'
  resetSession('eval'); also reset vlm cumulative usage.
  For each screenshot:
    const obs = await observe(buf, 'eval')
    if (!obs.changed) continue            // 0 tokens
    if (obs.keyframe && !obs.vlm_called) {
      // Text-only: send the event_summary as text to Claude
      const r = await anthropic.messages.create({
        model, max_tokens: 200,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Screenshot event: ${obs.event_summary}` }]}]
      })
      accumulate r.usage on the sonnet bucket
    }
    // If vlm_called, Haiku already ran inside observe(); track via getVlmCumulativeUsage at the end
  After the loop, add getVlmCumulativeUsage() to a separate haiku bucket so the slide shows both.

Output:
- Pretty-print a table matching Section 7.1's expected output
- Write eval/results/run_<ISO timestamp>.json with both runs' full numbers, per-screenshot breakdown, and computed savings
- Use the published Anthropic pricing constants at the top of the file (sonnet: $X/M in, $Y/M out; haiku: $A/M in, $B/M out) — flag in a comment that these need refreshing if pricing changes

Acceptance: `npm run measure` runs end-to-end without errors and produces the table. Two consecutive runs should be within 1% on token counts (some nondeterminism is fine).
```

**Person B — README MCP install snippets**
```
@spec

Write README.md sections:
1. What StateLens is (lift from Section 1)
2. Install: npm install -g statelens
3. Configure in Cursor: ~/.cursor/mcp.json snippet (path to statelens binary, args: ['serve'])
4. Configure in Claude Code: ~/.claude/mcp.json snippet (same shape)
5. Configure in Claude Desktop: claude_desktop_config.json snippet
6. Quickstart: ask the agent "use statelens_observe to walk through screenshots in <dir>"
7. Measuring savings: npm run measure command, expected output table
8. Architecture diagram (ASCII, lifted from Section 4.1)
9. License, contributing

Acceptance: a developer can install and configure StateLens in any of the three clients in under 2 minutes.
```

### 9.5 Daily Sync Points

Two short coordination moments keep the team aligned without slowing down:

- **End of hour 6:** Person A demos the pipeline producing diffs on the demo screenshots from CLI. Person B demos the MCP server connecting to Cursor with the stub. Integration confirmed.
- **End of hour 14:** Joint run of `eval/measure_tokens.ts` against the real pipeline. The headline number is locked. From this point, every change is verified against the harness so savings don't regress.

### 9.6 Solo Fallback

If one person drops out:
- **A solo (no Person B):** skip the measurement harness automation — do it manually with a spreadsheet of token counts from one-off API calls. Skip Cursor MCP integration. Keep the pipeline + CLI demo.
- **B solo (no Person A):** build only Stages 1, 2, 5 (skip OCR, importance scorer, timeline). Let Haiku do the heavy lifting on every non-identical frame. Less impressive savings but a working demo.

## 10. Technical Stack

### Core (Required)

| Component | Package | Why |
|---|---|---|
| Language | TypeScript | Ecosystem match: npm, MCP SDK, frontend devs |
| MCP | @modelcontextprotocol/sdk | Tool discovery for Claude Code, Cursor, etc. |
| Image diff | pixelmatch | Built for screenshot comparison, tiny, fast |
| Image processing | sharp | Resize, crop, buffer ops, libvips backend |
| OCR | tesseract.js | WASM OCR, no native deps |
| VLM | @anthropic-ai/sdk | Haiku calls for keyframe explanation |
| Schema validation | zod | MCP SDK uses it for tool input schemas |

### Stretch

| Component | Package | Why |
|---|---|---|
| Browser automation | playwright | Live agent integration demo |
| Terminal output | chalk + cli-table3 | Pretty CLI output for demo |
| Report | marked | Markdown report generation |

## 11. Evaluation and Metrics

### 11.1 Token Reduction (Empirical, Not Estimated)

The primary measurement is `eval/measure_tokens.ts` — the A/B harness described in Section 7.1. It runs the same screenshot task twice against `claude-sonnet-4-6`, with and without StateLens compression in the loop, and reports `response.usage.input_tokens` from the Anthropic API.

Crucially, the harness includes **honest accounting** for Haiku tokens consumed inside StateLens. Without this, we could be accused of "shifting tokens to a cheaper model" and pretending we saved them. The harness sums:

```
Run A total = sum(sonnet.usage.input_tokens) + sum(sonnet.usage.output_tokens)
Run B total = sum(sonnet.usage.input_tokens)       // text-only summaries
            + sum(sonnet.usage.output_tokens)
            + getVlmCumulativeUsage().input_tokens  // Haiku internal to StateLens
            + getVlmCumulativeUsage().output_tokens
```

We report both the token delta and the dollar-cost delta using current published Anthropic pricing. Judges can run `npm run measure` themselves to reproduce.

### 11.2 What Else We Measure

**Latency (exact, per pipeline stage)**: time each stage of `observe()` on the demo set. Target: visualGate <5ms, spatialDiff <10ms, ocrDiff <200ms, total pipeline median <300ms. Compare against baseline VLM call at 1-3s per frame.

**Keyframe selectivity**: count of frames filtered at each stage. Report the funnel: `14 frames → 9 pass visual gate → 7 are keyframes → 2 trigger VLM`.

**Timeline accuracy (qualitative)**: compare StateLens timeline output against a manually written ground truth file for each demo sequence. Report: "7/7 events correctly identified, 0 false positives."

### 11.3 What We Cannot Claim

We cannot claim success-rate improvement on agent benchmarks (OSWorld, WebTailBench, AgentNetBench). That requires running full agent loops at scale, outside hackathon scope. State this explicitly in the pitch.

### 11.4 Honest Framing for the Pitch

"ReVision validated that removing redundant visual information doesn't hurt agent success — they measured a +3% success-rate improvement after filtering. We measured the cost and latency side at the middleware layer: an A/B run of the same task against the same model with and without StateLens, using real token counts from the Anthropic API. End-to-end benchmark integration is on the roadmap."

## 12. Pitch

### 15 Second Version

UI agents waste money re-examining screenshots where nothing changed. StateLens is a screenshot gate that turns redundant frames into cheap semantic observations. Today it ships as MCP and an in-process adapter; next it becomes a local SDK gateway. 70-82% fewer input tokens in our measured flows.

### 60 Second Version

Every computer-use agent works the same way: screenshot, reason, act, repeat. Microsoft Research measured this: 36-56% of consecutive screenshots are pixel-identical. The agent pays full price to rediscover unchanged UI.

Existing solutions like ReVision require fine-tuning a specific model. They work for Qwen but not for Claude, not for GPT, not for anyone else.

StateLens is a model-external screenshot gate. Today, `npm install`, add it to your MCP config, and Claude Code, Cursor, or any MCP client can call `statelens_observe` before sending a screenshot to its reasoning model. For custom agents, the same pipeline is available as an in-process routing helper. The next surface is a local SDK gateway: point `ANTHROPIC_BASE_URL` at StateLens and screenshot-bearing requests are rewritten before they hit the expensive model. We run cheap local processing: pixel diff, OCR, spatial localization. We only call a small VLM for the fraction of frames where text cannot explain the visual change. The output is a semantic timeline the developer can read.

### 2 Minute Version (for Pitch Day)

[Problem] Computer-use agents are the next platform shift. Every major lab is shipping one. But they all share the same bottleneck: they look at the screen after every action and ask an expensive vision model "what happened?" Most of the time, the answer is "nothing." ReVision from Microsoft Research measured this: 36-56% of consecutive screenshots are pixel-identical. The agent is paying full price to rediscover that the toolbar is still there.

[Existing Solutions] Researchers have attacked this. ReVision trains a patch selector inside Qwen2.5-VL-7B that drops redundant tokens. It works: 46% token reduction, +3% success rate. But it requires fine-tuning a specific model on filtered trajectories. Anthropic cannot use it. OpenAI cannot use it. There is no install path for end users. The compression is invisible.

[StateLens] We built the opposite. StateLens is model-external. You can install it as an MCP server today, use it as an in-process adapter in custom loops, and the next step is a local gateway that sits in front of configurable SDKs. When a screenshot passes through StateLens, we run cheap local processing: pixel diffing to catch identical frames, OCR to extract text changes, spatial analysis to localize what moved. We only call a vision model for the rare frames where the visual change cannot be explained by text alone.

[Demo] Two pieces of evidence. First, the numbers. We built an A/B harness that runs the same screenshot task against Claude Sonnet twice — once sending raw images, once routing through StateLens. The token counts come straight from the Anthropic API. [show measure_tokens output] Input tokens drop 70-82% across the measured login and checkout flows, with honest accounting for internal Haiku calls. Second, the integration. [switch to Cursor window] Here is Cursor with StateLens installed as an MCP server. I ask it to walk through the same screenshots. Cursor discovers our four tools automatically, calls statelens_observe for each frame, and produces the semantic timeline. That MCP behavior stays. The next demo is the same pipeline running transparently through an SDK gateway.

[Vision] Every CUA needs this layer. We are shipping the MCP server so tool-aware clients can use it today, and we are moving toward SDK middleware and a local gateway so configurable agents can get the savings without rewriting their loops. The roadmap is clear: proxy validation, benchmark validation on OSWorld-style tasks, session analytics, and enterprise observability. StateLens: stop paying for screenshots that did not change.

## 13. What Makes This Different

StateLens is not a token pruning paper. It is not a model-internal optimization.

It is a **model-external screenshot gate** defined by five properties:

1. **Model-agnostic.** Works with any downstream VLM or agent framework. No fine-tuning.
2. **Multiple interception points.** MCP for tool-aware clients, in-process adapters for custom loops, SDK/proxy gateway for configurable model clients.
3. **Interpretable.** Produces human-readable semantic timelines, not invisible token masks.
4. **Cheap-first.** Local processing handles 80%+ of frames. VLM calls are the exception.
5. **Fail-open.** If StateLens cannot confidently rewrite a request, the gateway forwards the original screenshot-bearing request unchanged.

## 14. Risks and Mitigations

### Risk 1: tesseract.js WASM init is slow
**Mitigation:** Pre-warm the worker on server start. First call takes ~2s, subsequent calls <200ms. For the demo, the server is already warm.

### Risk 2: pixelmatch thresholds need tuning
**Mitigation:** Start conservative (2% diff threshold), test on demo screenshots in hour 2-3, tighten. pixelmatch has a built-in perceptual threshold parameter.

### Risk 3: Sharp native dependency fails to install
**Mitigation:** Sharp has prebuilt binaries for all platforms. If it fails, fall back to jimp (pure JS, slower but zero native deps).

### Risk 4: The editor agent does not call StateLens tools (defeats the live demo)
**Mitigation:** Three layers. (a) Tool descriptions explicitly say "call this before sending a screenshot to your reasoning model." (b) The demo prompt explicitly instructs "use statelens_observe instead of reading the images directly" — this mirrors what end users would put in their own CLAUDE.md or .cursorrules. (c) Critically, **the primary demo (`npm run measure`) does not depend on the editor agent at all.** It calls the Anthropic SDK directly with a controlled loop, so the token-savings numbers are deterministic and independent of editor behavior. The live MCP demo is the secondary "wow" — if it misbehaves, the headline numbers still hold.

### Risk 4b: The gateway rewrites too aggressively
**Mitigation:** Default to fail-open and text-only forwarding. `analysis_error`, `invalid_screenshot`, unsupported provider payloads, unknown streaming modes, and ambiguous image blocks all forward unchanged. Synthetic no-forward responses require an explicit opt-in flag because generic agents may rely on each model turn for planning or tool calls.

### Risk 5: Judges ask "why not just use ReVision?"
**Mitigation:** Prepared comparison: ReVision requires fine-tuning Qwen2.5-VL-7B, is model-specific, produces no developer-facing output, has no install path for end users. StateLens is `npm install`, model-agnostic, produces interpretable timelines.

### Risk 6: VLM calls are slow during live demo
**Mitigation:** Use prerecorded screenshots so results can be cached. Show latency numbers from a pre-run, do not depend on live API speed during the pitch.

## 15. Stretch Goals (Ordered by Impact)

1. **Live agent integration:** Playwright browser automation + StateLens, real-time compression
2. **Failure detection:** Detect when UI did not change after an action (click failed, page stuck)
3. **Diff visualization:** Save annotated screenshots with bounding boxes around changed regions
4. **HTML report:** Generate a visual session report with before/after thumbnails
5. **Cost calculator:** Input model pricing, get projected savings across session lengths
6. **Multi-language OCR:** tesseract.js supports 100+ languages
7. **SDK middleware:** `wrapAnthropic()` / `wrapOpenAI()` request rewriting in-process
8. **Local API gateway:** provider-compatible proxy using `ANTHROPIC_BASE_URL` / OpenAI endpoint overrides
9. **HTTP observation API:** explicit `POST /observe` endpoint for cross-language consumers

## 16. Integration Surfaces

StateLens core is a TypeScript library. The product should ship multiple wrappers for different interception points. MCP remains supported; proxy/gateway support is additive.

### Surface 1: MCP Server (Built)

For developers using Claude Code, Cursor, Windsurf, or any MCP client. This is the current zero-code tool-discovery integration.

```bash
npm install -g statelens
# Add to MCP config, done
```

MCP limitation: the agent must choose to call `statelens_observe`. This surface is excellent for tool-aware clients and demos, but it cannot force closed screenshot loops to gate vision calls.

### Surface 2: Library Import and Agent Adapter (Built)

For developers building custom agents in TypeScript/JavaScript who control their own loop. This is the post-Phase-3 in-process integration path — see `docs/POST_PHASE3_AGENT_INTEGRATION.md`.

Raw pipeline:
```typescript
import { observe } from 'statelens';
const result = await observe(screenshotBuffer, sessionId, actionLabel);
```

With the routing helper (recommended for agent loops):
```typescript
import { observe } from 'statelens';
import { routeObservation } from 'statelens/dist/src/adapters/routeObservation.js';

const observation = await observe(buffer, sessionId, actionLabel);
const route = routeObservation(observation);
// route.route ∈ { 'skip_vision', 'use_text_observation', 'use_full_vision' }
```

With the Playwright-shaped reference adapter (works with any Page-like object that exposes `screenshot(): Promise<Buffer>`):
```typescript
import { captureAndRoute } from 'statelens/dist/src/adapters/playwright.js';

const { screenshot, observation, route } = await captureAndRoute(page, {
  sessionId, actionLabel: 'click_submit',
});
```

The router and adapter live outside `src/pipeline/` so they do not expand Person A's locked surface. The pipeline contract — `observe()`, `getTimeline()`, `resetSession()`, `getVlmCumulativeUsage()`, `resetVlmCumulativeUsage()` — is unchanged.

### Surface 3: SDK Middleware (Planned)

For apps that instantiate the model SDK directly. This should be the first Tier 2 experiment because it avoids a separate process and proves request rewriting with minimal infrastructure.

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from 'statelens/anthropic';

const client = wrapAnthropic(new Anthropic(), { sessionId: 'run-123' });
```

This surface covers codebases where the user controls the SDK object but does not want to rewrite the whole agent loop.

### Surface 4: Local API Gateway / Proxy (Planned)

For SDK-based agents, binaries, or polyglot stacks that expose a provider endpoint override.

```bash
statelens proxy --provider anthropic --port 8443
export ANTHROPIC_BASE_URL=http://localhost:8443
```

The gateway receives provider-compatible model requests, rewrites screenshot-bearing payloads when StateLens has a cheaper observation, and forwards upstream. It is not a transparent MITM and should not require TLS interception.

### Surface 5: Standalone HTTP Observation API (Optional)

For cross-language consumers that want explicit calls rather than provider-compatible proxying.

```bash
statelens api --port 3000
# POST /observe, GET /session/:id/timeline
```

All surfaces wrap the same `observe()` function. The product direction is: keep MCP stable, validate SDK middleware first, then ship the local gateway once request rewriting and session semantics are proven.

## 17. Success Criteria

By the end of 48 hours, the project is successful if:

1. **`npm run measure` produces a reproducible token-savings table** with real numbers from the Anthropic API (this is the demo)
2. `statelens serve` starts an MCP server that Cursor (and Claude Code) discovers, exposing all four tools
3. `statelens_observe` correctly filters redundant frames and returns structured diffs
4. OCR text diff catches visible text changes on keyframes
5. VLM is called on only a minority of frames (target: <20%)
6. `statelens_timeline` returns an accurate semantic event log
7. Live MCP demo conversation in Cursor (or Claude Code) walks through the 14-frame login flow end to end
8. The pitch clearly positions StateLens vs ReVision and the academic landscape
9. The GitHub repo has a clean README with install instructions for Cursor, Claude Code, and Claude Desktop
10. The design doc specifies the SDK/proxy gateway path without changing the MCP tool contract

Nice to have:
1. Second demo scenario working
2. Live Playwright agent integration
3. Annotated diff images
4. HTML session report
5. SDK middleware prototype
6. Local Anthropic-compatible proxy prototype
7. HTTP observation API

## 18. Name

**StateLens**

```
Compress UI screenshots into the state changes agents actually need.
```

GitHub description:

```
Screenshot gateway for UI agents.
Filters redundant screenshots, extracts semantic state changes,
and cuts vision-token spend. Ships as MCP today; SDK/proxy gateway next.
```
