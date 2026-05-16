// Stage 5: Selective VLM Explainer — DESIGN.md Section 4.6
// Person A: Haiku call ONLY for visual-only keyframes.
//
// CRITICAL: maintain module-level cumulative usage counter so the measurement
// harness in eval/measure_tokens.ts can include Haiku tokens in StateLens's
// totals. Without honest accounting, our savings claim is unverifiable.

import type { Buffer } from 'node:buffer';
import type { ChangedRegion, VlmUsage } from './index.js';

let cumulativeUsage: VlmUsage = { input_tokens: 0, output_tokens: 0 };

export interface VlmExplanation {
  eventType: string;
  summary: string;
  importantText: string[];
}

export async function vlmExplain(
  _prevBuffer: Buffer,
  _currBuffer: Buffer,
  _regions: ChangedRegion[]
): Promise<VlmExplanation> {
  // TODO Person A: implement per DESIGN.md Section 4.6.
  // After every Anthropic API call:
  //   cumulativeUsage.input_tokens += response.usage.input_tokens;
  //   cumulativeUsage.output_tokens += response.usage.output_tokens;
  throw new Error('vlmExplain not implemented');
}

export function getCumulativeUsage(): VlmUsage {
  return { ...cumulativeUsage };
}

export function resetCumulativeUsage(): void {
  cumulativeUsage = { input_tokens: 0, output_tokens: 0 };
}
