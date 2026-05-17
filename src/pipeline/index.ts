// Pipeline orchestrator — integration contract between Person A and Person B.
// See DESIGN.md Section 5.2 and docs/PIPELINE_PHASE2_IMPLEMENTATION.md.

import type { Buffer } from 'node:buffer';
import { visualGate } from './visualGate.js';
import { spatialDiff } from './spatialDiff.js';
import { ocrDiff, prewarmOcrWorker } from './ocrDiff.js';
import { importanceScore } from './importanceScorer.js';
import {
  vlmExplain,
  getCumulativeUsage,
  resetCumulativeUsage,
} from './vlmExplainer.js';
import { SessionTimeline } from './timeline.js';
import { tryGetImageDimensions } from '../utils/image.js';
import { shouldExpectVisualChange } from './actionExpectation.js';
import {
  deleteSession,
  getOrCreateSession,
  peekSession,
} from './sessionStore.js';

export interface ChangedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface TextDiff {
  added: string[];
  removed: string[];
}

// Region Evidence types — docs/REGION_EVIDENCE_DESIGN.md.
// Kept additive so existing ObservationResult consumers are not broken.
export type ObservationConfidence = 'high' | 'medium' | 'low';

export type EvidenceRegionSource = 'heuristic' | 'ocr' | 'vlm' | 'mixed';

export interface EvidenceRegion {
  id: string;
  label: string;
  // [left, top, right, bottom] — easier for downstream consumers and matches
  // the shape rendered in the observation text format.
  bbox: [number, number, number, number];
  source: EvidenceRegionSource;
  confidence: ObservationConfidence;
  text?: string[];
}

export interface VisualEvidence {
  id: string;
  region_id: string;
  kind: 'crop';
  media_type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  data_base64?: string;
  file_path?: string;
}

export interface ObservationResult {
  changed: boolean;
  keyframe: boolean;
  importance_score: number;
  event_type: string;
  event_summary: string;
  changed_regions: ChangedRegion[];
  text_diff: TextDiff;
  vlm_called: boolean;
  latency_ms: number;
  // Optional so the existing observe() contract remains additive — Region
  // Evidence callers always populate it, the legacy code path leaves it unset.
  confidence?: ObservationConfidence;
}

export interface EvidenceObservation {
  changed: boolean;
  keyframe: boolean;
  importance_score: number;
  confidence: ObservationConfidence;
  event_type: string;
  event_summary: string;
  changed_regions: EvidenceRegion[];
  text_diff: TextDiff;
  visual_evidence: VisualEvidence[];
  vlm_called: boolean;
  latency_ms: number;
}

// Geometry helper used both internally (region labeling, formatting) and by
// downstream consumers that want to convert legacy ChangedRegion to bbox form.
export function bboxFromRegion(region: {
  x: number;
  y: number;
  w: number;
  h: number;
}): [number, number, number, number] {
  const x1 = Math.round(region.x);
  const y1 = Math.round(region.y);
  const x2 = Math.round(region.x + region.w);
  const y2 = Math.round(region.y + region.h);
  return [x1, y1, x2, y2];
}

export interface TimelineEvent {
  step: number;
  event_type: string;
  summary: string;
  text_diff: TextDiff;
  regions: ChangedRegion[];
  vlm_used: boolean;
}

export interface TimelineResult {
  session_id: string;
  total_screenshots: number;
  keyframes: number;
  vlm_calls_made: number;
  vlm_calls_saved: number;
  reduction_pct: number;
  estimated_tokens_saved: number;
  events: TimelineEvent[];
}

export interface VlmUsage {
  input_tokens: number;
  output_tokens: number;
}

function emptyTextDiff(): TextDiff {
  return { added: [], removed: [] };
}

function buildObservation(
  start: number,
  fields: {
    changed: boolean;
    keyframe: boolean;
    importanceScore: number;
    eventType: string;
    eventSummary: string;
    changedRegions?: ChangedRegion[];
    textDiff?: TextDiff;
    vlmCalled?: boolean;
  }
): ObservationResult {
  return {
    changed: fields.changed,
    keyframe: fields.keyframe,
    importance_score: fields.importanceScore,
    event_type: fields.eventType,
    event_summary: fields.eventSummary,
    changed_regions: fields.changedRegions ?? [],
    text_diff: fields.textDiff ?? emptyTextDiff(),
    vlm_called: fields.vlmCalled ?? false,
    latency_ms: Date.now() - start,
  };
}

function recordTimelineEvent(
  session: SessionTimeline,
  start: number,
  fields: {
    changed: boolean;
    importanceScore: number;
    eventType: string;
    eventSummary: string;
    changedRegions?: ChangedRegion[];
    textDiff?: TextDiff;
    vlmCalled?: boolean;
  }
): ObservationResult {
  const regions = fields.changedRegions ?? [];
  const textDiff = fields.textDiff ?? emptyTextDiff();
  const vlmCalled = fields.vlmCalled ?? false;

  session.addEvent({
    step: session.totalScreenshots,
    event_type: fields.eventType,
    summary: fields.eventSummary,
    text_diff: textDiff,
    regions,
    vlm_used: vlmCalled,
  });

  return buildObservation(start, {
    changed: fields.changed,
    keyframe: true,
    importanceScore: fields.importanceScore,
    eventType: fields.eventType,
    eventSummary: fields.eventSummary,
    changedRegions: regions,
    textDiff,
    vlmCalled,
  });
}

function recordKeyframe(
  session: SessionTimeline,
  start: number,
  fields: {
    importanceScore: number;
    eventType: string;
    eventSummary: string;
    changedRegions?: ChangedRegion[];
    textDiff?: TextDiff;
    vlmCalled?: boolean;
  }
): ObservationResult {
  return recordTimelineEvent(session, start, { ...fields, changed: true });
}

async function timedStage<T>(
  session: SessionTimeline,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (process.env.STATELENS_PROFILE !== '1') {
    return fn();
  }

  const timerLabel = `statelens:${session.sessionId}:step${session.totalScreenshots}:${label}`;
  console.time(timerLabel);
  try {
    return await fn();
  } finally {
    console.timeEnd(timerLabel);
  }
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

export async function observe(
  screenshotBuffer: Buffer,
  sessionId: string = 'default',
  actionLabel?: string
): Promise<ObservationResult> {
  const start = Date.now();
  const session = getOrCreateSession(sessionId);
  session.incrementTotal();

  try {
    const currDimensions = await timedStage(session, 'stage0.decode', () =>
      tryGetImageDimensions(screenshotBuffer)
    );

    if (!currDimensions) {
      return buildObservation(start, {
        changed: false,
        keyframe: false,
        importanceScore: 0,
        eventType: 'invalid_screenshot',
        eventSummary: 'Screenshot could not be decoded; previous session state was preserved',
        textDiff: emptyTextDiff(),
      });
    }

    const prev = session.getPrevScreenshot();
    session.setPrevScreenshot(screenshotBuffer);

    if (!prev) {
      return recordKeyframe(session, start, {
        importanceScore: 1.0,
        eventType: 'session_start',
        eventSummary: 'First screenshot in session',
        textDiff: emptyTextDiff(),
      });
    }

    // Stage 1: cheap visual gate
    let gate;
    try {
      gate = await timedStage(session, 'stage1.visualGate', () =>
        visualGate(prev, screenshotBuffer)
      );
    } catch (err) {
      return recordKeyframe(session, start, {
        importanceScore: 1,
        eventType: 'analysis_error',
        eventSummary: `Visual gate failed; returning current screenshot as a keyframe (${shortError(err)})`,
        textDiff: emptyTextDiff(),
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
        return recordTimelineEvent(session, start, {
          changed: false,
          importanceScore: 0.6,
          eventType: 'action_failed',
          eventSummary: `Action "${label}" produced no meaningful UI change; the action may have failed or the page may be stuck`,
          textDiff: emptyTextDiff(),
        });
      }

      return buildObservation(start, {
        changed: false,
        keyframe: false,
        importanceScore: 0,
        eventType: 'no_change',
        eventSummary: `Filtered by ${gate.gate}`,
        textDiff: emptyTextDiff(),
      });
    }

    // Stage 2: spatial diff
    let regions: ChangedRegion[];
    try {
      regions = await timedStage(session, 'stage2.spatialDiff', () =>
        spatialDiff(prev, screenshotBuffer)
      );
    } catch (err) {
      return recordKeyframe(session, start, {
        importanceScore: 1,
        eventType: 'analysis_error',
        eventSummary: `Spatial diff failed; returning current screenshot as a keyframe (${shortError(err)})`,
        textDiff: emptyTextDiff(),
      });
    }

    // Stage 3: OCR text diff on changed regions only
    let textDiff = emptyTextDiff();
    let ocrError: unknown = null;
    if (regions.length > 0) {
      try {
        textDiff = await timedStage(session, 'stage3.ocrDiff', () =>
          ocrDiff(prev, screenshotBuffer, regions)
        );
      } catch (err) {
        ocrError = err;
      }
    }

    // Stage 4: importance scoring
    const scoring = importanceScore(
      regions,
      textDiff,
      currDimensions.width,
      currDimensions.height
    );

    if (ocrError && scoring.score < 0.3) {
      return recordKeyframe(session, start, {
        importanceScore: Math.max(scoring.score, 0.3),
        eventType: 'ocr_unavailable',
        eventSummary: `Visual change detected; OCR text extraction failed (${shortError(ocrError)})`,
        changedRegions: regions,
        textDiff,
      });
    }

    if (scoring.score < 0.3) {
      return buildObservation(start, {
        changed: true,
        keyframe: false,
        importanceScore: scoring.score,
        eventType: 'minor_change',
        eventSummary: 'Minor visual change, not significant',
        changedRegions: regions,
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
      // Stage 5: selective VLM. If the model/API fails, return a local fallback
      // keyframe instead of throwing out of the user-facing pipeline.
      const usageBefore = getCumulativeUsage();
      try {
        const vlmResult = await timedStage(session, 'stage5.vlmExplain', () =>
          vlmExplain(prev, screenshotBuffer, regions)
        );
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

    // Stage 6: timeline assembly
    return recordKeyframe(session, start, {
      importanceScore: scoring.score,
      eventType,
      eventSummary,
      changedRegions: regions,
      textDiff,
      vlmCalled,
    });
  } catch (err) {
    try {
      return recordKeyframe(session, start, {
        importanceScore: 1,
        eventType: 'analysis_error',
        eventSummary: `Pipeline analysis failed; returning current screenshot as a keyframe (${shortError(err)})`,
        textDiff: emptyTextDiff(),
      });
    } catch {
      return buildObservation(start, {
        changed: true,
        keyframe: true,
        importanceScore: 1,
        eventType: 'analysis_error',
        eventSummary: `Pipeline analysis failed (${shortError(err)})`,
        textDiff: emptyTextDiff(),
      });
    }
  }
}

export function getTimeline(sessionId: string = 'default'): TimelineResult {
  const session = peekSession(sessionId);
  if (!session) {
    return {
      session_id: sessionId,
      total_screenshots: 0,
      keyframes: 0,
      vlm_calls_made: 0,
      vlm_calls_saved: 0,
      reduction_pct: 0,
      estimated_tokens_saved: 0,
      events: [],
    };
  }
  return session.getTimeline();
}

export function resetSession(sessionId: string = 'default'): void {
  deleteSession(sessionId);
}

// Exposed for eval/measure_tokens.ts honest accounting (DESIGN.md Section 11.1).
// Proxies the real Stage 5 counter so Haiku usage is included in StateLens totals.
export function getVlmCumulativeUsage(): VlmUsage {
  return getCumulativeUsage();
}

export function resetVlmCumulativeUsage(): void {
  resetCumulativeUsage();
}

// Optional Phase 3 prewarm hook for servers/CLIs that want to pay the
// tesseract.js startup cost before the first OCR-bearing observation.
export async function prewarmPipeline(): Promise<void> {
  await prewarmOcrWorker();
}

export { prewarmOcrWorker };
