// Routing helper that turns an ObservationResult into an explicit decision an
// agent loop can act on. See docs/POST_PHASE3_AGENT_INTEGRATION.md §"Agent
// Routing Helper" for the policy table. Lives outside src/pipeline/ so it does
// not expand the locked pipeline surface owned by Person A (ROLE_PIPELINE.md).

import type { ObservationResult } from '../pipeline/index.js';

export type ObservationRoute =
  | {
      route: 'skip_vision';
      reason: string;
      observation: ObservationResult;
    }
  | {
      route: 'use_text_observation';
      context: string;
      observation: ObservationResult;
    }
  | {
      route: 'use_full_vision';
      reason: string;
      observation: ObservationResult;
    };

function formatTextContext(observation: ObservationResult): string {
  const parts: string[] = [];
  parts.push(`Event: ${observation.event_type}`);
  parts.push(`Summary: ${observation.event_summary}`);

  const { added, removed } = observation.text_diff;
  if (added.length) parts.push(`Text appeared: ${added.map((t) => JSON.stringify(t)).join(', ')}`);
  if (removed.length) parts.push(`Text disappeared: ${removed.map((t) => JSON.stringify(t)).join(', ')}`);

  if (observation.changed_regions.length) {
    const labels = [...new Set(observation.changed_regions.map((r) => r.label))];
    parts.push(`Regions changed: ${labels.join(', ')}`);
  }

  return parts.join('\n');
}

export function routeObservation(observation: ObservationResult): ObservationRoute {
  // Failure modes from the pipeline should fall through to full vision so the
  // caller does not silently lose state. invalid_screenshot is technically
  // changed:false but the pipeline used it to signal "I could not analyze
  // this" — treat it like an analysis error rather than a no-op.
  if (
    observation.event_type === 'invalid_screenshot' ||
    observation.event_type === 'analysis_error'
  ) {
    return {
      route: 'use_full_vision',
      reason: `StateLens could not produce a confident observation (${observation.event_type}); fall back to raw vision.`,
      observation,
    };
  }

  if (!observation.changed) {
    return {
      route: 'skip_vision',
      reason: `No meaningful UI change detected (${observation.event_type}).`,
      observation,
    };
  }

  if (!observation.keyframe) {
    // changed=true but pipeline rejected it as a keyframe (e.g. minor_change).
    // Trust the pipeline: the change is not significant enough to spend tokens.
    return {
      route: 'skip_vision',
      reason: `Change present but below the keyframe threshold (${observation.event_type}, score=${observation.importance_score.toFixed(2)}).`,
      observation,
    };
  }

  // Keyframe path. Both vlm_called=false (text-sufficient) and vlm_called=true
  // (StateLens already paid for a small Haiku call and parsed the result) carry
  // enough text in event_summary + text_diff to ground the agent's next turn.
  // Routing to use_text_observation in both cases is what produces the headline
  // token savings; callers that want raw pixels can ignore the context and use
  // observation directly.
  return {
    route: 'use_text_observation',
    context: formatTextContext(observation),
    observation,
  };
}
