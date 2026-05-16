// Stage 4: Importance Scorer — DESIGN.md Section 4.5
// Person A: rule-based scoring to decide keyframe / VLM-call threshold.

import type { ChangedRegion, TextDiff } from './index.js';

export interface ScoreResult {
  score: number;
  textSufficient: boolean;
  shouldCallVlm: boolean;
}

export function importanceScore(
  _regions: ChangedRegion[],
  _textDiff: TextDiff,
  _imgW: number,
  _imgH: number
): ScoreResult {
  // TODO Person A: implement per DESIGN.md Section 4.5.
  throw new Error('importanceScore not implemented');
}
