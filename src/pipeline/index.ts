// Pipeline orchestrator — integration contract between Person A and Person B.
// See DESIGN.md Section 5.2 and docs/PIPELINE_PHASE2_IMPLEMENTATION.md.

import type { Buffer } from 'node:buffer';
import { visualGate } from './visualGate.js';
import { spatialDiff } from './spatialDiff.js';
import { ocrDiff } from './ocrDiff.js';
import { importanceScore } from './importanceScorer.js';
import {
  vlmExplain,
  getCumulativeUsage,
  resetCumulativeUsage,
} from './vlmExplainer.js';
import { SessionTimeline } from './timeline.js';
import { getImageDimensions } from '../utils/image.js';

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

const EMPTY_TEXT_DIFF: TextDiff = { added: [], removed: [] };
const sessions = new Map<string, SessionTimeline>();

function getOrCreateSession(sessionId: string): SessionTimeline {
  let session = sessions.get(sessionId);
  if (!session) {
    session = new SessionTimeline(sessionId);
    sessions.set(sessionId, session);
  }
  return session;
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
  _actionLabel?: string
): Promise<ObservationResult> {
  const start = Date.now();
  const session = getOrCreateSession(sessionId);
  session.incrementTotal();

  const prev = session.getPrevScreenshot();
  session.setPrevScreenshot(screenshotBuffer);

  if (!prev) {
    const event: TimelineEvent = {
      step: session.totalScreenshots,
      event_type: 'session_start',
      summary: 'First screenshot in session',
      text_diff: EMPTY_TEXT_DIFF,
      regions: [],
      vlm_used: false,
    };
    session.addEvent(event);
    return {
      changed: true,
      keyframe: true,
      importance_score: 1.0,
      event_type: 'session_start',
      event_summary: event.summary,
      changed_regions: [],
      text_diff: EMPTY_TEXT_DIFF,
      vlm_called: false,
      latency_ms: Date.now() - start,
    };
  }

  // Stage 1: cheap visual gate
  const gate = await visualGate(prev, screenshotBuffer);
  if (!gate.changed) {
    return {
      changed: false,
      keyframe: false,
      importance_score: 0,
      event_type: 'no_change',
      event_summary: `Filtered by ${gate.gate}`,
      changed_regions: [],
      text_diff: EMPTY_TEXT_DIFF,
      vlm_called: false,
      latency_ms: Date.now() - start,
    };
  }

  // Stage 2: spatial diff
  const regions = await spatialDiff(prev, screenshotBuffer);

  // Stage 3: OCR text diff on changed regions only
  const textDiff = regions.length > 0
    ? await ocrDiff(prev, screenshotBuffer, regions)
    : EMPTY_TEXT_DIFF;

  // Stage 4: importance scoring
  const { width, height } = await getImageDimensions(screenshotBuffer);
  const scoring = importanceScore(regions, textDiff, width, height);

  if (scoring.score < 0.3) {
    return {
      changed: true,
      keyframe: false,
      importance_score: scoring.score,
      event_type: 'minor_change',
      event_summary: 'Minor visual change, not significant',
      changed_regions: regions,
      text_diff: textDiff,
      vlm_called: false,
      latency_ms: Date.now() - start,
    };
  }

  let eventType: string;
  let eventSummary: string;
  let vlmCalled = false;

  if (scoring.textSufficient) {
    eventType = inferEventType(textDiff);
    eventSummary = buildTextSummary(textDiff, regions);
  } else if (scoring.shouldCallVlm) {
    // Stage 5: selective VLM
    const vlmResult = await vlmExplain(prev, screenshotBuffer, regions);
    eventType = vlmResult.eventType;
    eventSummary = vlmResult.summary;
    vlmCalled = true;
  } else {
    eventType = 'ui_change';
    eventSummary = buildRegionSummary(regions);
  }

  // Stage 6: timeline assembly
  const event: TimelineEvent = {
    step: session.totalScreenshots,
    event_type: eventType,
    summary: eventSummary,
    text_diff: textDiff,
    regions,
    vlm_used: vlmCalled,
  };
  session.addEvent(event);

  return {
    changed: true,
    keyframe: true,
    importance_score: scoring.score,
    event_type: eventType,
    event_summary: eventSummary,
    changed_regions: regions,
    text_diff: textDiff,
    vlm_called: vlmCalled,
    latency_ms: Date.now() - start,
  };
}

export function getTimeline(sessionId: string = 'default'): TimelineResult {
  const session = sessions.get(sessionId);
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
  sessions.delete(sessionId);
}

// Exposed for eval/measure_tokens.ts honest accounting (DESIGN.md Section 11.1).
// Proxies the real Stage 5 counter so Haiku usage is included in StateLens totals.
export function getVlmCumulativeUsage(): VlmUsage {
  return getCumulativeUsage();
}

export function resetVlmCumulativeUsage(): void {
  resetCumulativeUsage();
}
