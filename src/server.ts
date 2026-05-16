// MCP server — DESIGN.md Section 5.1
// Person B: register the four StateLens tools and bridge to src/pipeline/index.ts.
//
// Tool descriptions: use the EXACT strings from DESIGN.md Section 3.
// Those descriptions guide model tool-selection behavior — don't paraphrase.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  observe,
  getTimeline,
  resetSession,
} from './pipeline/index.js';

const server = new McpServer({
  name: 'statelens',
  version: '0.1.0',
});

server.tool(
  'statelens_observe',
  'Analyze a UI screenshot for changes since the last observation. Returns structured diff including whether anything changed, what text appeared/disappeared, where the change occurred, and a semantic event summary. Call this before sending a screenshot to your reasoning model to avoid wasting tokens on unchanged screens.',
  {
    screenshot_path: z.string().describe('Absolute path to the screenshot image file (PNG or JPEG)'),
    session_id: z.string().default('default').describe('Session identifier to track state across observations.'),
    action_label: z.string().optional().describe('Optional label for the action that preceded this screenshot.'),
  },
  async ({ screenshot_path, session_id, action_label }) => {
    const buffer = await readFile(screenshot_path);
    const result = await observe(buffer, session_id, action_label);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'statelens_timeline',
  'Get the semantic timeline of all UI state changes detected in a session. Includes cost savings metrics and event summaries.',
  {
    session_id: z.string().default('default'),
  },
  async ({ session_id }) => {
    const timeline = getTimeline(session_id);
    return { content: [{ type: 'text', text: JSON.stringify(timeline, null, 2) }] };
  }
);

server.tool(
  'statelens_compare',
  'Compare two screenshots directly and return the structured diff between them. Does not require a session.',
  {
    before_path: z.string().describe('Path to the earlier screenshot'),
    after_path: z.string().describe('Path to the later screenshot'),
  },
  async ({ before_path: _before, after_path }) => {
    // TODO Person B: dedicated compare path that doesn't pollute a session.
    const buffer = await readFile(after_path);
    const result = await observe(buffer, `compare_${Date.now()}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'statelens_reset',
  'Reset a session, clearing all stored state and timeline events.',
  {
    session_id: z.string().default('default'),
  },
  async ({ session_id }) => {
    resetSession(session_id);
    return { content: [{ type: 'text', text: `Session "${session_id}" reset.` }] };
  }
);

export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
