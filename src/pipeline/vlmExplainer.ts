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
const MAX_TOKENS = 200;

let cumulativeUsage: VlmUsage = { input_tokens: 0, output_tokens: 0 };
let client: Anthropic | null = null;

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
    client = new Anthropic();
  }
  return client;
}

async function detectMediaType(buffer: Buffer): Promise<'image/jpeg' | 'image/png'> {
  try {
    const meta = await sharp(buffer).metadata();
    if (meta.format === 'jpeg' || meta.format === 'jpg') return 'image/jpeg';
  } catch {
    // fall through to default
  }
  return 'image/png';
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
  const [prevMedia, currMedia] = await Promise.all([
    detectMediaType(prevBuffer),
    detectMediaType(currBuffer),
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
            source: {
              type: 'base64',
              media_type: prevMedia,
              data: prevBuffer.toString('base64'),
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: currMedia,
              data: currBuffer.toString('base64'),
            },
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
