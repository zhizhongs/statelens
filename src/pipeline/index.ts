// Pipeline orchestrator — integration contract between Person A and Person B.
// See DESIGN.md Section 9.2.

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

// TODO Person A: implement per DESIGN.md Section 4 (Stages 1-6).
// This stub lets Person B build the MCP server and measurement harness
// against a stable interface from hour one.
export async function observe(
  _screenshotBuffer: Buffer,
  _sessionId: string = 'default',
  _actionLabel?: string
): Promise<ObservationResult> {
  const start = Date.now();
  return {
    changed: true,
    keyframe: true,
    importance_score: 1.0,
    event_type: 'stub',
    event_summary: 'Pipeline not implemented yet — replace this stub.',
    changed_regions: [],
    text_diff: { added: [], removed: [] },
    vlm_called: false,
    latency_ms: Date.now() - start,
  };
}

export function getTimeline(sessionId: string = 'default'): TimelineResult {
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

export function resetSession(_sessionId: string = 'default'): void {
  // TODO: clear session state
}

// Exposed for eval/measure_tokens.ts honest accounting (DESIGN.md Section 11.1).
export function getVlmCumulativeUsage(): VlmUsage {
  return { input_tokens: 0, output_tokens: 0 };
}

export function resetVlmCumulativeUsage(): void {
  // TODO
}
