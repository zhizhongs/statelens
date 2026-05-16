// Pipeline orchestrator — integration contract between Person A and Person B.
// See DESIGN.md Section 9.2 and docs/PIPELINE_PHASE1_IMPLEMENTATION.md.

import type { Buffer } from 'node:buffer';
import { visualGate } from './visualGate.js';
import { spatialDiff } from './spatialDiff.js';
import { ocrDiff } from './ocrDiff.js';
import { SessionTimeline } from './timeline.js';

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

function buildPhase1Summary(textDiff: TextDiff, regions: ChangedRegion[]): string {
  const firstAdded = textDiff.added[0];
  const firstRemoved = textDiff.removed[0];
  if (firstAdded && firstRemoved) {
    return `Text changed: added "${firstAdded}", removed "${firstRemoved}"`;
  }
  if (firstAdded) {
    return `Text appeared: "${firstAdded}"`;
  }
  if (firstRemoved) {
    return `Text disappeared: "${firstRemoved}"`;
  }
  if (regions.length) {
    const uniqueLabels = [...new Set(regions.map((r) => r.label))].slice(0, 3);
    return `UI changed in ${uniqueLabels.join(', ')}`;
  }
  return 'Visual change detected';
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

  const regions = await spatialDiff(prev, screenshotBuffer);
  const textDiff = regions.length > 0
    ? await ocrDiff(prev, screenshotBuffer, regions)
    : EMPTY_TEXT_DIFF;

  const textChanged = textDiff.added.length > 0 || textDiff.removed.length > 0;
  const eventType = textChanged ? 'text_changed' : 'ui_changed';
  const importance = textChanged ? 0.6 : 0.4;
  const summary = buildPhase1Summary(textDiff, regions);

  const event: TimelineEvent = {
    step: session.totalScreenshots,
    event_type: eventType,
    summary,
    text_diff: textDiff,
    regions,
    vlm_used: false,
  };
  session.addEvent(event);

  return {
    changed: true,
    keyframe: true,
    importance_score: importance,
    event_type: eventType,
    event_summary: summary,
    changed_regions: regions,
    text_diff: textDiff,
    vlm_called: false,
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
// Phase 1 makes no VLM calls; Phase 2 will replace these with real counters.
export function getVlmCumulativeUsage(): VlmUsage {
  return { input_tokens: 0, output_tokens: 0 };
}

export function resetVlmCumulativeUsage(): void {
  // No-op in Phase 1.
}
