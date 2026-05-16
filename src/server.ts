import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Buffer } from 'node:buffer';
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

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function decodeBase64Screenshot(raw: string): Buffer {
  // Tolerate data URLs like "data:image/png;base64,iVBOR..." that some agents
  // produce when they encode a screenshot inline.
  const commaIdx = raw.indexOf(',');
  const payload =
    raw.startsWith('data:') && commaIdx !== -1 ? raw.slice(commaIdx + 1) : raw;
  const cleaned = payload.replace(/\s+/g, '');
  if (!cleaned || !BASE64_RE.test(cleaned)) {
    throw new Error('screenshot_base64 is not valid base64 data');
  }
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.length === 0) {
    throw new Error('screenshot_base64 decoded to an empty buffer');
  }
  return buf;
}

server.tool(
  'statelens_observe',
  'Analyze a UI screenshot for changes since the last observation. Returns structured diff including whether anything changed, what text appeared/disappeared, where the change occurred, and a semantic event summary. Call this before sending a screenshot to your reasoning model to avoid wasting tokens on unchanged screens. Provide exactly one of screenshot_path (local file) or screenshot_base64 (in-memory image).',
  {
    screenshot_path: z
      .string()
      .optional()
      .describe('Absolute path to the screenshot image file (PNG or JPEG). Mutually exclusive with screenshot_base64.'),
    screenshot_base64: z
      .string()
      .optional()
      .describe('Base64-encoded screenshot bytes (PNG or JPEG). Use this when the agent holds the screenshot in memory and does not want to write a temp file. Mutually exclusive with screenshot_path.'),
    mime_type: z
      .enum(['image/png', 'image/jpeg'])
      .optional()
      .describe('Optional MIME type for screenshot_base64. Informational only; sharp auto-detects the actual format.'),
    session_id: z.string().default('default').describe('Session identifier to track state across observations.'),
    action_label: z.string().optional().describe('Optional label for the action that preceded this screenshot.'),
  },
  async ({ screenshot_path, screenshot_base64, session_id, action_label }) => {
    try {
      if (!screenshot_path && !screenshot_base64) {
        throw new Error('Provide exactly one of screenshot_path or screenshot_base64.');
      }
      if (screenshot_path && screenshot_base64) {
        throw new Error('Provide only one of screenshot_path or screenshot_base64, not both.');
      }
      const buffer = screenshot_path
        ? await readFile(screenshot_path)
        : decodeBase64Screenshot(screenshot_base64!);
      const result = await observe(buffer, session_id, action_label);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
    }
  }
);

server.tool(
  'statelens_timeline',
  'Get the semantic timeline of all UI state changes detected in a session. Includes cost savings metrics and event summaries.',
  {
    session_id: z.string().default('default'),
  },
  async ({ session_id }) => {
    try {
      const timeline = getTimeline(session_id);
      return { content: [{ type: 'text', text: JSON.stringify(timeline, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
    }
  }
);

server.tool(
  'statelens_compare',
  'Compare two screenshots directly and return the structured diff between them. Does not require a session.',
  {
    before_path: z.string().describe('Path to the earlier screenshot'),
    after_path: z.string().describe('Path to the later screenshot'),
  },
  async ({ before_path, after_path }) => {
    try {
      const [beforeBuf, afterBuf] = await Promise.all([
        readFile(before_path),
        readFile(after_path),
      ]);
      const sessionId = `__compare_${Date.now()}`;
      await observe(beforeBuf, sessionId);
      const result = await observe(afterBuf, sessionId);
      resetSession(sessionId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
    }
  }
);

server.tool(
  'statelens_reset',
  'Reset a session, clearing all stored state and timeline events.',
  {
    session_id: z.string().default('default'),
  },
  async ({ session_id }) => {
    try {
      resetSession(session_id);
      return { content: [{ type: 'text', text: `Session "${session_id}" reset.` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
    }
  }
);

export async function main(): Promise<void> {
  console.error('StateLens MCP server v0.1.0 starting on stdio...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
