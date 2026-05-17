// Region labeling stage — docs/REGION_EVIDENCE_DESIGN.md §"Semantic Region
// Labeling". Takes ChangedRegion[] plus optional region-local OCR text and
// produces EvidenceRegion[] with semantic snake_case labels, source provenance,
// and per-region confidence.

import type {
  ChangedRegion,
  EvidenceRegion,
  EvidenceRegionSource,
  ObservationConfidence,
} from './index.js';
import { bboxFromRegion } from './index.js';
import { classifyRegion } from './spatialDiff.js';

// Snake_case taxonomy from the design doc. Keep these in sync with the proxy
// formatter and any downstream agents that match on label names.
export const SEMANTIC_LABELS = {
  shipping_form: [
    'name',
    'address',
    'zip',
    'city',
    'state',
    'phone',
    'email',
    'shipping',
    'street',
  ],
  delivery_options: [
    'delivery',
    'shipping method',
    'pickup',
    'date',
    'express',
    'standard',
    'tuesday',
    'wednesday',
    'thursday',
  ],
  payment_method: [
    'card',
    'paypal',
    'apple pay',
    'google pay',
    'cvv',
    'expiration',
    'visa',
    'mastercard',
  ],
  login_form: [
    'username',
    'password',
    'sign in',
    'login',
    'log in',
  ],
  error_message: [
    'error',
    'invalid',
    'required',
    'failed',
    'denied',
  ],
  navigation: [
    'next',
    'continue',
    'back',
    'checkout',
    'submit',
    'proceed',
  ],
} as const;

export type SemanticLabel = keyof typeof SEMANTIC_LABELS;

// Geometry fallbacks use snake_case so they share the taxonomy with the
// keyword-derived labels. The old classifyRegion() returns space-separated
// strings ("top banner") for the legacy ObservationResult format — we map
// those to snake_case here.
const GEOMETRY_TO_SNAKE: Record<string, string> = {
  'top banner': 'top_banner',
  'bottom bar': 'bottom_bar',
  'left sidebar': 'left_sidebar',
  'right panel': 'right_panel',
  'center modal': 'center_modal',
  'content area': 'content_area',
};

function geometryLabel(region: ChangedRegion, imgW: number, imgH: number): string {
  const raw =
    region.label && region.label.trim().length
      ? region.label
      : classifyRegion(region, imgW, imgH);
  return GEOMETRY_TO_SNAKE[raw] ?? raw.replace(/\s+/g, '_').toLowerCase();
}

// "Wordish" line check mirrors importanceScorer.isTextReliable(): keep tokens
// that look like real words so symbol noise ("a / ® |") doesn't trigger a
// payment_form label by accident.
function reliableTextTokens(text: string[]): string[] {
  return text
    .map((line) => line.trim())
    .filter((line) => line.length >= 2)
    .filter((line) => line.replace(/[^A-Za-z0-9]/g, '').length >= 2);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeyword(haystack: string, keyword: string): boolean {
  // Use word boundaries on both sides so `name` doesn't swallow `username` and
  // `email` doesn't swallow `your_email_address` substrings that belong to a
  // login_form / similar region. Multi-word keywords keep their literal spaces.
  const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`);
  return pattern.test(haystack);
}

function detectSemanticLabel(text: string[]): SemanticLabel | null {
  const reliable = reliableTextTokens(text);
  if (reliable.length === 0) return null;

  const haystack = reliable.join(' ').toLowerCase();
  // Order matters: error_message wins over navigation when both match so we
  // don't swallow "submit failed" into the navigation bucket. login_form is
  // ranked above shipping_form because authentication forms also include
  // shipping-form-adjacent words like `email`, and the more specific intent
  // (login) should win.
  const priority: SemanticLabel[] = [
    'error_message',
    'payment_method',
    'login_form',
    'delivery_options',
    'shipping_form',
    'navigation',
  ];

  for (const label of priority) {
    const keywords = SEMANTIC_LABELS[label];
    if (keywords.some((kw) => matchesKeyword(haystack, kw))) {
      return label;
    }
  }
  return null;
}

export interface ConfidenceInputs {
  ocrReliable: boolean;
  labelSource: EvidenceRegionSource;
  regionCount: number;
  // Per-region area as a fraction of the screen. Very large or very tiny
  // regions are less trustworthy.
  areaFraction: number;
}

// Per-region confidence — the design doc's confidence model says confidence
// describes the reliability of the observation, not the importance of the
// frame.
export function confidenceForRegion(inputs: ConfidenceInputs): ObservationConfidence {
  const { ocrReliable, labelSource, regionCount, areaFraction } = inputs;

  // Many fragmented regions → low. Single dense region with no OCR backing →
  // medium at best.
  if (regionCount >= 6) return 'low';
  if (!ocrReliable && labelSource === 'heuristic') return 'low';
  if (areaFraction > 0.6) return 'low';

  if (
    ocrReliable &&
    (labelSource === 'ocr' || labelSource === 'vlm' || labelSource === 'mixed') &&
    regionCount <= 3
  ) {
    return 'high';
  }

  return 'medium';
}

// Aggregate confidence — collapses per-region confidences to a single value for
// the EvidenceObservation envelope. The aggregate is the *weakest* link with a
// bias toward the most common rating so a single noisy region doesn't tank an
// otherwise clean observation.
export function aggregateConfidence(
  regionConfidences: ObservationConfidence[]
): ObservationConfidence {
  if (regionConfidences.length === 0) return 'low';
  if (regionConfidences.some((c) => c === 'low')) return 'low';
  if (regionConfidences.every((c) => c === 'high')) return 'high';
  return 'medium';
}

function dedupeText(lines: string[] | undefined): string[] | undefined {
  if (!lines || lines.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.length ? out : undefined;
}

export interface RegionLabelerInputs {
  regions: ChangedRegion[];
  // Per-region OCR text. Length should match `regions`. Index alignment lets
  // a single region inherit only its own crop's text, not the full text_diff.
  ocrTextByRegion?: string[][];
  imageWidth: number;
  imageHeight: number;
  // Optional override map from the VLM — `region_index -> { label, confidence }`.
  // The VLM contract is opt-in: a missing entry means fall through to OCR /
  // geometry labeling.
  vlmRegionHints?: Map<
    number,
    { label?: string; confidence?: ObservationConfidence }
  >;
}

export interface RegionLabelerOutput {
  regions: EvidenceRegion[];
  confidence: ObservationConfidence;
}

export function regionLabeler(inputs: RegionLabelerInputs): RegionLabelerOutput {
  const {
    regions,
    ocrTextByRegion,
    imageWidth,
    imageHeight,
    vlmRegionHints,
  } = inputs;

  const screenArea = Math.max(imageWidth * imageHeight, 1);

  const evidenceRegions: EvidenceRegion[] = regions.map((region, index) => {
    const ocrText = ocrTextByRegion?.[index] ?? [];
    const ocrReliable = reliableTextTokens(ocrText).length > 0;
    const semantic = detectSemanticLabel(ocrText);
    const vlmHint = vlmRegionHints?.get(index);

    let label: string;
    let source: EvidenceRegionSource;
    if (vlmHint?.label && vlmHint.label.trim().length) {
      label = vlmHint.label.trim();
      source = semantic ? 'mixed' : 'vlm';
    } else if (semantic) {
      label = semantic;
      source = ocrReliable ? 'ocr' : 'mixed';
    } else {
      label = geometryLabel(region, imageWidth, imageHeight);
      source = ocrReliable ? 'mixed' : 'heuristic';
    }

    const areaFraction = (region.w * region.h) / screenArea;
    let confidence = confidenceForRegion({
      ocrReliable,
      labelSource: source,
      regionCount: regions.length,
      areaFraction,
    });

    // VLM-provided confidence is conservative: only weaken, never strengthen.
    if (vlmHint?.confidence) {
      const order: ObservationConfidence[] = ['low', 'medium', 'high'];
      if (order.indexOf(vlmHint.confidence) < order.indexOf(confidence)) {
        confidence = vlmHint.confidence;
      }
    }

    return {
      id: `crop_${index + 1}`,
      label,
      bbox: bboxFromRegion(region),
      source,
      confidence,
      text: dedupeText(ocrText),
    };
  });

  return {
    regions: evidenceRegions,
    confidence: aggregateConfidence(evidenceRegions.map((r) => r.confidence)),
  };
}
