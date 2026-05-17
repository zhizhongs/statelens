// Region Evidence orchestrator — docs/REGION_EVIDENCE_DESIGN.md §"API Plan".
// Mirrors observe() but produces an EvidenceObservation: semantic region
// labels, per-region/aggregate confidence, and optional crop payloads.
//
// We intentionally do not modify observe() itself — keeping that surface
// stable is a stated non-goal in the design doc. The proxy and library can
// pick between the two APIs depending on whether they want crops.

import type { Buffer } from 'node:buffer';
import { visualGate } from './visualGate.js';
import { spatialDiff } from './spatialDiff.js';
import { ocrDiffDetailed } from './ocrDiff.js';
import { importanceScore } from './importanceScorer.js';
import { vlmExplain, getCumulativeUsage } from './vlmExplainer.js';
import { tryGetImageDimensions } from '../utils/image.js';
import { shouldExpectVisualChange } from './actionExpectation.js';
import { regionLabeler } from './regionLabeler.js';
import { buildVisualEvidence, DEFAULT_CROP_OPTIONS } from './evidenceCropper.js';
import {
  bboxFromRegion,
  type ChangedRegion,
  type EvidenceObservation,
  type EvidenceRegion,
  type ObservationConfidence,
  type TextDiff,
  type VisualEvidence,
  type VlmUsage,
} from './index.js';

// Mirrors the eligibility rules in routeEvidenceObservation() — used to skip
// crop encoding entirely on frames where the route will end up as
// skip_vision / use_text_observation / use_full_vision and the crops would be
// thrown away. Encoding 1-3 PNG crops can take 100-400ms; on a busy session
// that adds up fast, so the cheapest crop is the one we never build.
//
// IMPORTANT: keep this in lock-step with `routeEvidenceObservation()`. The
// router now prefers evidence routes whenever at least one region is anchored
// (source !== 'heuristic'), even on low aggregate confidence — so this gate
// only filters out the cases where crops are *guaranteed* to be discarded:
// nothing changed, or every region is heuristic-only.
function wouldUseCrops(
  labeled: { regions: EvidenceRegion[]; confidence: ObservationConfidence },
  maxCrops: number
): boolean {
  if (labeled.regions.length === 0) return false;
  // Heuristic-only labels route to use_text_observation in the router, so
  // crops would be wasted.
  if (!labeled.regions.some((r) => r.source !== 'heuristic')) return false;
  // > maxCrops still wants crops (routes to use_context_snapshot with the
  // first maxCrops). Anything else gets crops too.
  return true;
}

// Imported indirectly to reuse the session map / VLM accounting that observe()
// already wires up. Keeping a single SessionTimeline source of truth means
// callers can interleave observe() and observeWithEvidence() in the same
// session without losing event history.
import { _internal as orchestratorInternal } from './observeInternal.js';

export interface ObserveEvidenceOptions {
  sessionId?: string;
  actionLabel?: string;
  // Disabled by default for library and MCP callers — turning crops on incurs
  // image encoding cost even when the route ends up not using them.
  includeCrops?: boolean;
  cropEncoding?: 'base64' | 'file';
  maxCrops?: number;
  maxCropEdge?: number;
  cropPaddingPx?: number;
  cropFileDir?: string;
  // Performance tuning passthroughs to buildVisualEvidence().
  cropFormat?: 'png' | 'jpeg';
  cropJpegQuality?: number;
  cropPngCompressionLevel?: number;
}

function emptyTextDiff(): TextDiff {
  return { added: [], removed: [] };
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

function usageIncreased(before: VlmUsage, after: VlmUsage): boolean {
  return (
    after.input_tokens > before.input_tokens ||
    after.output_tokens > before.output_tokens
  );
}

function inferEventType(textDiff: TextDiff): string {
  const added = textDiff.added.join(' ').toLowerCase();
  if (/(error|invalid|failed|denied|required)/.test(added)) return 'error_appeared';
  if (added.includes('warning')) return 'warning_appeared';
  if (textDiff.added.length && textDiff.removed.length) return 'text_changed';
  if (textDiff.added.length) return 'text_appeared';
  if (textDiff.removed.length) return 'text_removed';
  return 'ui_change';
}

function buildTextSummary(textDiff: TextDiff, regions: ChangedRegion[]): string {
  const added = textDiff.added.slice(0, 3);
  const removed = textDiff.removed.slice(0, 3);
  if (added.length && removed.length) {
    return `Text changed: added "${added.join(' / ')}", removed "${removed.join(' / ')}"`;
  }
  if (added.length) {
    return `Text appeared: "${added.join(' / ')}"`;
  }
  if (removed.length) {
    return `Text disappeared: "${removed.join(' / ')}"`;
  }
  if (regions.length) {
    const uniqueLabels = [...new Set(regions.map((r) => r.label))].slice(0, 3);
    return `UI changed in ${uniqueLabels.join(', ')}`;
  }
  return 'Visual change detected';
}

function buildRegionSummary(regions: ChangedRegion[]): string {
  if (!regions.length) return 'Visual change detected';
  const uniqueLabels = [...new Set(regions.map((r) => r.label))].slice(0, 3);
  return `UI changed in ${uniqueLabels.join(', ')}`;
}

function staticEvidenceObservation(args: {
  start: number;
  changed: boolean;
  keyframe: boolean;
  importanceScore: number;
  confidence: ObservationConfidence;
  eventType: string;
  eventSummary: string;
  regions?: EvidenceRegion[];
  textDiff?: TextDiff;
  visualEvidence?: VisualEvidence[];
  vlmCalled?: boolean;
}): EvidenceObservation {
  return {
    changed: args.changed,
    keyframe: args.keyframe,
    importance_score: args.importanceScore,
    confidence: args.confidence,
    event_type: args.eventType,
    event_summary: args.eventSummary,
    changed_regions: args.regions ?? [],
    text_diff: args.textDiff ?? emptyTextDiff(),
    visual_evidence: args.visualEvidence ?? [],
    vlm_called: args.vlmCalled ?? false,
    latency_ms: Date.now() - args.start,
  };
}

// Build a synthetic EvidenceRegion list for fallback paths (session_start,
// action_failed, analysis_error). These don't have OCR-backed labels so the
// caller knows the confidence is whatever we assert.
function synthesizeFallbackRegions(
  regions: ChangedRegion[]
): EvidenceRegion[] {
  return regions.map((region, index) => ({
    id: `crop_${index + 1}`,
    label: region.label.replace(/\s+/g, '_').toLowerCase() || 'content_area',
    bbox: bboxFromRegion(region),
    source: 'heuristic' as const,
    confidence: 'low' as const,
  }));
}

export async function observeWithEvidence(
  screenshotBuffer: Buffer,
  options: ObserveEvidenceOptions = {}
): Promise<EvidenceObservation> {
  const start = Date.now();
  const sessionId = options.sessionId ?? 'default';
  const actionLabel = options.actionLabel;
  const session = orchestratorInternal.getOrCreateSession(sessionId);
  session.incrementTotal();

  try {
    const currDimensions = await tryGetImageDimensions(screenshotBuffer);

    if (!currDimensions) {
      return staticEvidenceObservation({
        start,
        changed: false,
        keyframe: false,
        importanceScore: 0,
        confidence: 'low',
        eventType: 'invalid_screenshot',
        eventSummary:
          'Screenshot could not be decoded; previous session state was preserved',
      });
    }

    const prev = session.getPrevScreenshot();
    session.setPrevScreenshot(screenshotBuffer);

    if (!prev) {
      orchestratorInternal.recordEvidenceKeyframe(session, {
        eventType: 'session_start',
        eventSummary: 'First screenshot in session',
        regions: [],
        textDiff: emptyTextDiff(),
        vlmCalled: false,
      });
      return staticEvidenceObservation({
        start,
        changed: true,
        keyframe: true,
        importanceScore: 1.0,
        confidence: 'high',
        eventType: 'session_start',
        eventSummary: 'First screenshot in session',
      });
    }

    // Stage 1: cheap visual gate
    let gate;
    try {
      gate = await visualGate(prev, screenshotBuffer);
    } catch (err) {
      orchestratorInternal.recordEvidenceKeyframe(session, {
        eventType: 'analysis_error',
        eventSummary: `Visual gate failed; returning current screenshot as a keyframe (${shortError(err)})`,
        regions: [],
        textDiff: emptyTextDiff(),
        vlmCalled: false,
      });
      return staticEvidenceObservation({
        start,
        changed: true,
        keyframe: true,
        importanceScore: 1,
        confidence: 'low',
        eventType: 'analysis_error',
        eventSummary: `Visual gate failed; returning current screenshot as a keyframe (${shortError(err)})`,
      });
    }

    if (!gate.changed) {
      let expectChange = false;
      try {
        expectChange = shouldExpectVisualChange(actionLabel);
      } catch {
        expectChange = false;
      }

      if (expectChange) {
        const label = (actionLabel ?? '').trim();
        const eventSummary = `Action "${label}" produced no meaningful UI change; the action may have failed or the page may be stuck`;
        orchestratorInternal.recordEvidenceKeyframe(session, {
          eventType: 'action_failed',
          eventSummary,
          regions: [],
          textDiff: emptyTextDiff(),
          vlmCalled: false,
        });
        return staticEvidenceObservation({
          start,
          changed: false,
          keyframe: true,
          importanceScore: 0.6,
          confidence: 'medium',
          eventType: 'action_failed',
          eventSummary,
        });
      }

      return staticEvidenceObservation({
        start,
        changed: false,
        keyframe: false,
        importanceScore: 0,
        confidence: 'high',
        eventType: 'no_change',
        eventSummary: `Filtered by ${gate.gate}`,
      });
    }

    // Stage 2: spatial diff
    let regions: ChangedRegion[];
    try {
      regions = await spatialDiff(prev, screenshotBuffer);
    } catch (err) {
      orchestratorInternal.recordEvidenceKeyframe(session, {
        eventType: 'analysis_error',
        eventSummary: `Spatial diff failed; returning current screenshot as a keyframe (${shortError(err)})`,
        regions: [],
        textDiff: emptyTextDiff(),
        vlmCalled: false,
      });
      return staticEvidenceObservation({
        start,
        changed: true,
        keyframe: true,
        importanceScore: 1,
        confidence: 'low',
        eventType: 'analysis_error',
        eventSummary: `Spatial diff failed (${shortError(err)})`,
        regions: synthesizeFallbackRegions([]),
      });
    }

    // Stage 3: per-region OCR — gives us both the legacy TextDiff and the
    // per-region text the labeler needs.
    let detailedOcr = { added: [] as string[], removed: [] as string[], byRegion: [] as {prev: string[]; curr: string[]}[] };
    let ocrError: unknown = null;
    if (regions.length > 0) {
      try {
        detailedOcr = await ocrDiffDetailed(prev, screenshotBuffer, regions);
      } catch (err) {
        ocrError = err;
      }
    }
    const textDiff: TextDiff = { added: detailedOcr.added, removed: detailedOcr.removed };
    const ocrTextByRegion = detailedOcr.byRegion.map((entry) => entry.curr ?? []);

    // Stage 4: importance scoring
    const scoring = importanceScore(
      regions,
      textDiff,
      currDimensions.width,
      currDimensions.height
    );

    if (ocrError && scoring.score < 0.3) {
      const eventSummary = `Visual change detected; OCR text extraction failed (${shortError(ocrError)})`;
      orchestratorInternal.recordEvidenceKeyframe(session, {
        eventType: 'ocr_unavailable',
        eventSummary,
        regions,
        textDiff,
        vlmCalled: false,
      });
      return staticEvidenceObservation({
        start,
        changed: true,
        keyframe: true,
        importanceScore: Math.max(scoring.score, 0.3),
        confidence: 'low',
        eventType: 'ocr_unavailable',
        eventSummary,
        regions: synthesizeFallbackRegions(regions),
        textDiff,
      });
    }

    if (scoring.score < 0.3) {
      return staticEvidenceObservation({
        start,
        changed: true,
        keyframe: false,
        importanceScore: scoring.score,
        confidence: 'low',
        eventType: 'minor_change',
        eventSummary: 'Minor visual change, not significant',
        regions: synthesizeFallbackRegions(regions),
        textDiff,
      });
    }

    let eventType: string;
    let eventSummary: string;
    let vlmCalled = false;

    if (scoring.textSufficient) {
      eventType = inferEventType(textDiff);
      eventSummary = buildTextSummary(textDiff, regions);
    } else if (scoring.shouldCallVlm) {
      const usageBefore = getCumulativeUsage();
      try {
        const vlmResult = await vlmExplain(prev, screenshotBuffer, regions);
        eventType = vlmResult.eventType;
        eventSummary = vlmResult.summary;
        vlmCalled = true;
      } catch (err) {
        const usageAfter = getCumulativeUsage();
        vlmCalled = usageIncreased(usageBefore, usageAfter);
        eventType = inferEventType(textDiff);
        eventSummary = `${buildTextSummary(textDiff, regions)}; VLM explanation unavailable (${shortError(err)})`;
      }
    } else {
      eventType = 'ui_change';
      eventSummary = buildRegionSummary(regions);
    }

    // Region labeling — converts ChangedRegion[] + region-local OCR text into
    // semantic EvidenceRegion[].
    const labeled = regionLabeler({
      regions,
      ocrTextByRegion,
      imageWidth: currDimensions.width,
      imageHeight: currDimensions.height,
    });

    // Crop generation is opt-in *and* gated on whether the route would
    // actually consume the crops — skipping the encode pass on no-op routes
    // is the cheapest perf win available.
    const maxCrops = options.maxCrops ?? DEFAULT_CROP_OPTIONS.maxCrops;
    let visualEvidence: VisualEvidence[] = [];
    if (options.includeCrops && wouldUseCrops(labeled, maxCrops)) {
      try {
        visualEvidence = await buildVisualEvidence(
          screenshotBuffer,
          labeled.regions,
          {
            maxCrops,
            maxCropEdge: options.maxCropEdge ?? DEFAULT_CROP_OPTIONS.maxCropEdge,
            paddingPx: options.cropPaddingPx ?? DEFAULT_CROP_OPTIONS.paddingPx,
            encoding: options.cropEncoding ?? DEFAULT_CROP_OPTIONS.encoding,
            fileDir: options.cropFileDir,
            format: options.cropFormat,
            jpegQuality: options.cropJpegQuality,
            pngCompressionLevel: options.cropPngCompressionLevel,
          }
        );
      } catch (err) {
        // Crop failure is non-fatal — the observation is still useful without
        // crops; the router will fall through to use_text_observation. We log
        // the failure to stderr so silently empty `visual_evidence` arrays
        // don't look like a no-op when cropping is meant to be active.
        console.error(
          `[statelens] buildVisualEvidence failed: ${shortError(err)}`
        );
        visualEvidence = [];
      }
    }

    // Stage 6: record keyframe under the session timeline so observe() and
    // observeWithEvidence() agree on event history.
    orchestratorInternal.recordEvidenceKeyframe(session, {
      eventType,
      eventSummary,
      regions,
      textDiff,
      vlmCalled,
    });

    return staticEvidenceObservation({
      start,
      changed: true,
      keyframe: true,
      importanceScore: scoring.score,
      confidence: labeled.confidence,
      eventType,
      eventSummary,
      regions: labeled.regions,
      textDiff,
      visualEvidence,
      vlmCalled,
    });
  } catch (err) {
    try {
      orchestratorInternal.recordEvidenceKeyframe(session, {
        eventType: 'analysis_error',
        eventSummary: `Pipeline analysis failed; returning current screenshot as a keyframe (${shortError(err)})`,
        regions: [],
        textDiff: emptyTextDiff(),
        vlmCalled: false,
      });
    } catch {
      // swallow — already returning a fallback observation.
    }
    return staticEvidenceObservation({
      start,
      changed: true,
      keyframe: true,
      importanceScore: 1,
      confidence: 'low',
      eventType: 'analysis_error',
      eventSummary: `Pipeline analysis failed (${shortError(err)})`,
    });
  }
}
