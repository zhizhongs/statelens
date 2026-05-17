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
// Haiku response is a small JSON ({event_type, summary, important_text})
// — empirically ~60-90 tokens. 120 leaves margin without paying for an
// allocation Sonnet generation latency budget we never use.
const MAX_TOKENS = 120;
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
  return `You are analyzing two consecutive UI screenshots.
Describe only the meaningful UI state change in one sentence.
Changed region: ${JSON.stringify(regions)}

Focus on: error messages, modals, button state changes, form changes, navigation, content loading, layout shifts.

Return JSON only:
{
  "event_type": "short_snake_case",
  "summary": "one concise sentence",
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
