// Stage 5: Selective VLM Explainer — DESIGN.md Section 4.6
// Person A: Haiku call ONLY for visual-only keyframes.
//
// CRITICAL: maintain module-level cumulative usage counter so the measurement
// harness in eval/measure_tokens.ts can include Haiku tokens in StateLens's
// totals. Without honest accounting, our savings claim is unverifiable.

import { Buffer } from 'node:buffer';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import type { ChangedRegion, VlmUsage } from './index.js';

const MODEL = 'claude-haiku-4-5-20251001';
// Haiku response is a JSON object. Original budget was 200; trimmed to 120
// when summaries were short delta-blurbs. The updated prompt asks for
// specific, full-screen descriptions to match what the agent would have
// gotten from Sonnet, which needs ~150-180 output tokens. 200 leaves margin.
const MAX_TOKENS = 200;
// Downscale screenshots before sending to Haiku. Anthropic prices images by
// tile count, which scales with resolution. 768px on the long edge keeps UI
// text readable while dropping per-image input tokens ~3-4x vs full-res.
// Configurable via STATELENS_VLM_MAX_EDGE — smaller = cheaper + faster Haiku
// but risks losing legibility of small UI text. 384-768 is the practical range.
function configuredVlmMaxEdge(): number {
  const raw = process.env.STATELENS_VLM_MAX_EDGE;
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= 128 && parsed <= 2048) return parsed;
  return 768;
}
const VLM_MAX_EDGE = configuredVlmMaxEdge();

let cumulativeUsage: VlmUsage = { input_tokens: 0, output_tokens: 0 };
let client: Anthropic | null = null;

async function prepareForVlm(buffer: Buffer): Promise<{ data: string; mediaType: 'image/png' }> {
  const resized = await sharp(buffer)
    .resize(VLM_MAX_EDGE, VLM_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { data: resized.toString('base64'), mediaType: 'image/png' };
}

export interface VlmExplanation {
  eventType: string;
  summary: string;
  importantText: string[];
}

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required for vlmExplain()');
    }
    const baseURL =
      process.env.STATELENS_INTERNAL_ANTHROPIC_BASE_URL ??
      (process.env.STATELENS_PROXY_ACTIVE === '1'
        ? process.env.STATELENS_ANTHROPIC_UPSTREAM_BASE_URL ?? 'https://api.anthropic.com'
        : undefined);
    client = new Anthropic(baseURL ? { baseURL } : undefined);
  }
  return client;
}

function buildPrompt(regions: ChangedRegion[]): string {
  // The "summary" field is what a downstream Sonnet (or synthesized response
  // in fast mode) will surface to the agent. Agents typically ask
  // "describe what is on this UI" — frame Haiku's answer to MATCH that
  // shape, not a delta-only blurb. Including the prior screen as context
  // helps Haiku ground specific elements (button labels, field values,
  // error messages) instead of generic "UI changed" boilerplate.
  return `You are looking at two consecutive UI screenshots from a computer-use agent.
The first image is the previous state; the second is the current state.

Write a one-sentence description of WHAT IS ON THE CURRENT SCREEN, written
the way an answer to "describe what is on this UI screenshot" would read.
Use the previous screen as context but make the sentence about the current
state, not just the change. Be specific: name visible buttons, error
messages, field contents, page titles, and any state changes.

Changed regions (for reference): ${JSON.stringify(regions)}

Return JSON only, no prose outside the object:
{
  "event_type": "short_snake_case",
  "summary": "one specific sentence describing the current UI state",
  "important_text": ["key visible text"]
}`;
}

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  throw new Error('vlmExplain: Anthropic response had no text block');
}

function parseJsonPayload(raw: string): VlmExplanation {
  const stripped = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(stripped) as {
    event_type?: string;
    summary?: string;
    important_text?: string[];
  };
  return {
    eventType: parsed.event_type ?? 'ui_change',
    summary: parsed.summary ?? '',
    importantText: Array.isArray(parsed.important_text) ? parsed.important_text : [],
  };
}

export async function vlmExplain(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  regions: ChangedRegion[]
): Promise<VlmExplanation> {
  const anthropic = getClient();
  const [prev, curr] = await Promise.all([
    prepareForVlm(prevBuffer),
    prepareForVlm(currBuffer),
  ]);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: prev.mediaType, data: prev.data },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: curr.mediaType, data: curr.data },
          },
          { type: 'text', text: buildPrompt(regions) },
        ],
      },
    ],
  });

  // Count usage BEFORE parsing — if the model returns malformed JSON, the API
  // call still happened and must be reflected in cumulative totals.
  cumulativeUsage.input_tokens += response.usage?.input_tokens ?? 0;
  cumulativeUsage.output_tokens += response.usage?.output_tokens ?? 0;

  const text = extractText(response);
  return parseJsonPayload(text);
}

export function getCumulativeUsage(): VlmUsage {
  return { ...cumulativeUsage };
}

export function resetCumulativeUsage(): void {
  cumulativeUsage = { input_tokens: 0, output_tokens: 0 };
}
