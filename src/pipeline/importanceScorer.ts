// Stage 4: Importance Scorer — DESIGN.md Section 4.5
// Person A: rule-based scoring to decide keyframe / VLM-call threshold.

import type { ChangedRegion, TextDiff } from './index.js';

export interface ScoreResult {
  score: number;
  textSufficient: boolean;
  shouldCallVlm: boolean;
}

const ERROR_KEYWORDS = ['error', 'invalid', 'failed', 'denied', 'warning', 'required'];

// Reject OCR output that looks like noise rather than meaningful text.
// Symptoms observed on Zara checkout's stylized form fields: short fragments
// dominated by punctuation/symbols ("a / ® |"), single-char tokens. The
// downstream agent gets garbage if we hand these off as "text changed".
function isTextReliable(textDiff: TextDiff): boolean {
  if (textDiff.added.length === 0) return false;
  const combined = textDiff.added.join(' ').trim();
  if (combined.length < 4) return false;
  const alphaChars = combined.replace(/[^A-Za-z0-9]/g, '').length;
  if (alphaChars / Math.max(combined.length, 1) < 0.5) return false;
  // At least one chunk must be a "word-ish" string (3+ alphanumerics).
  const wordish = textDiff.added.filter(
    (s) => s.replace(/[^A-Za-z0-9]/g, '').length >= 3
  );
  return wordish.length > 0;
}

export function importanceScore(
  regions: ChangedRegion[],
  textDiff: TextDiff,
  imgW: number,
  imgH: number
): ScoreResult {
  let score = 0;
  const reliable = isTextReliable(textDiff);

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

  // Text is "sufficient" only when the OCR output passed the reliability check.
  // Otherwise we route to VLM even at lower scores — better one Haiku call than
  // a downstream summary like "Text appeared: 'a / ® |'".
  const textSufficient = reliable && score < 0.7;
  const shouldCallVlm =
    !textSufficient &&
    (score > 0.4 || (textDiff.added.length > 0 && !reliable));

  return { score, textSufficient, shouldCallVlm };
}
