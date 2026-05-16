// Stage 4: Importance Scorer — DESIGN.md Section 4.5
// Person A: rule-based scoring to decide keyframe / VLM-call threshold.

import type { ChangedRegion, TextDiff } from './index.js';

export interface ScoreResult {
  score: number;
  textSufficient: boolean;
  shouldCallVlm: boolean;
}

const ERROR_KEYWORDS = ['error', 'invalid', 'failed', 'denied', 'warning', 'required'];

export function importanceScore(
  regions: ChangedRegion[],
  textDiff: TextDiff,
  imgW: number,
  imgH: number
): ScoreResult {
  let score = 0;

  if (textDiff.added.length > 0) {
    score += 0.4;
    const allText = textDiff.added.join(' ').toLowerCase();
    if (ERROR_KEYWORDS.some((kw) => allText.includes(kw))) {
      score += 0.2;
    }
  }

  if (imgW > 0 && imgH > 0) {
    const totalArea = regions.reduce((sum, r) => sum + r.w * r.h, 0);
    const screenArea = imgW * imgH;
    if (totalArea > 0.1 * screenArea) {
      score += 0.3;
    }
  }

  if (regions.some((r) => r.label === 'center modal')) {
    score += 0.1;
  }

  const textSufficient = textDiff.added.length > 0 && score < 0.7;
  const shouldCallVlm = score > 0.5 && !textSufficient;

  return { score, textSufficient, shouldCallVlm };
}
