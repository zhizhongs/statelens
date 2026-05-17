// Routing helper that turns an ObservationResult into an explicit decision an
// agent loop can act on. See docs/POST_PHASE3_AGENT_INTEGRATION.md §"Agent
// Routing Helper" for the policy table. Lives outside src/pipeline/ so it does
// not expand the locked pipeline surface owned by Person A (ROLE_PIPELINE.md).
//
// Region Evidence route additions live below — docs/REGION_EVIDENCE_DESIGN.md
// §"Routing Plan". They route on an `EvidenceObservation` that carries
// per-region confidence and optional crop payloads.

import type {
  EvidenceObservation,
  EvidenceRegion,
  ObservationResult,
  VisualEvidence,
} from '../pipeline/index.js';

export const DEFAULT_SCREENSHOT_INPUT_TOKEN_ESTIMATE = 1200;
// Cost guardrails — docs/REGION_EVIDENCE_DESIGN.md §"Cost Guardrails".
// Crops that cover more than this fraction of the screen lose their savings
// versus a full screenshot, so the router falls through to context_snapshot /
// full_vision instead.
export const REGION_EVIDENCE_MAX_AREA_FRACTION = 0.45;
export const REGION_EVIDENCE_MAX_CROPS = 3;

export type ObservationRoute =
  | {
      route: 'skip_vision';
      reason: string;
      observation: ObservationResult | EvidenceObservation;
    }
  | {
      route: 'use_text_observation';
      context: string;
      observation: ObservationResult | EvidenceObservation;
    }
  | {
      route: 'use_region_evidence';
      context: string;
      evidence: VisualEvidence[];
      observation: EvidenceObservation;
    }
  | {
      route: 'use_context_snapshot';
      context: string;
      evidence: VisualEvidence[];
      observation: EvidenceObservation;
    }
  | {
      route: 'use_full_vision';
      reason: string;
      observation: ObservationResult | EvidenceObservation;
    };

export interface RouteSavingsEstimate {
  total_observations: number;
  downstream_vision_calls: number;
  downstream_vision_calls_saved: number;
  estimated_downstream_input_tokens_saved: number;
  assumed_tokens_per_screenshot: number;
}

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

export function estimateRouteSavings(
  routes: ObservationRoute[],
  tokensPerScreenshot: number = DEFAULT_SCREENSHOT_INPUT_TOKEN_ESTIMATE
): RouteSavingsEstimate {
  const downstreamVisionCalls = routes.filter((route) => route.route === 'use_full_vision').length;
  const downstreamVisionCallsSaved = routes.length - downstreamVisionCalls;
  return {
    total_observations: routes.length,
    downstream_vision_calls: downstreamVisionCalls,
    downstream_vision_calls_saved: downstreamVisionCallsSaved,
    estimated_downstream_input_tokens_saved: downstreamVisionCallsSaved * tokensPerScreenshot,
    assumed_tokens_per_screenshot: tokensPerScreenshot,
  };
}

// ---------------------------------------------------------------------------
// Region Evidence routing — docs/REGION_EVIDENCE_DESIGN.md
// ---------------------------------------------------------------------------

function formatEvidenceContext(observation: EvidenceObservation): string {
  const lines: string[] = [
    'StateLens observation for the latest UI screenshot:',
    `Event: ${observation.event_type}`,
    `Summary: ${observation.event_summary}`,
    `Confidence: ${observation.confidence}`,
  ];

  const { added, removed } = observation.text_diff;
  if (added.length) {
    lines.push(`Text appeared: ${added.map((t) => JSON.stringify(t)).join(', ')}`);
  }
  if (removed.length) {
    lines.push(`Text disappeared: ${removed.map((t) => JSON.stringify(t)).join(', ')}`);
  }

  if (observation.changed_regions.length) {
    lines.push('Changed regions:');
    observation.changed_regions.forEach((region, index) => {
      const bbox = `[${region.bbox.join(', ')}]`;
      const evidenceId =
        observation.visual_evidence.find((ev) => ev.region_id === region.id)?.id ?? region.id;
      lines.push(
        `${index + 1}. ${region.label}, bbox: ${bbox}, evidence: ${evidenceId}`
      );
    });
  }

  return lines.join('\n');
}

function hasReliableLabels(regions: EvidenceRegion[]): boolean {
  if (!regions.length) return false;
  return regions.some((r) => r.source !== 'heuristic');
}

// Returns true if the cropper dropped any region the observation reported —
// usually because the region exceeded maxAreaFraction or the merge step
// collapsed multiple regions into a single crop. The router treats these as
// signals for use_context_snapshot instead of use_region_evidence.
function someRegionsLackEvidence(observation: EvidenceObservation): boolean {
  const evidenceIds = new Set(observation.visual_evidence.map((ev) => ev.region_id));
  return observation.changed_regions.some((r) => !evidenceIds.has(r.id));
}

export interface RouteEvidenceOptions {
  // When true the router may pick use_region_evidence / use_context_snapshot.
  // When false the router stays on the legacy 3-route policy so callers that
  // didn't ask for crops never receive them.
  allowEvidenceRoutes?: boolean;
  maxCrops?: number;
}

export function routeEvidenceObservation(
  observation: EvidenceObservation,
  options: RouteEvidenceOptions = {}
): ObservationRoute {
  const {
    allowEvidenceRoutes = true,
    maxCrops = REGION_EVIDENCE_MAX_CROPS,
  } = options;

  // Failures and first-frame grounding must fall through to full vision — same
  // policy as routeObservation() so the proxy never silently loses state.
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
    return {
      route: 'skip_vision',
      reason: `Change present but below the keyframe threshold (${observation.event_type}, score=${observation.importance_score.toFixed(2)}).`,
      observation,
    };
  }

  // Very low confidence on a keyframe means the pipeline isn't sure what it's
  // looking at — show the model the raw pixels rather than guess.
  if (observation.confidence === 'low') {
    return {
      route: 'use_full_vision',
      reason: `Low-confidence keyframe (${observation.event_type}); fall back to raw vision.`,
      observation,
    };
  }

  const regions = observation.changed_regions;
  const evidence = observation.visual_evidence;
  const labelsReliable = hasReliableLabels(regions);

  if (allowEvidenceRoutes && regions.length > 0 && evidence.length > 0 && labelsReliable) {
    const fitsRegionEvidence =
      regions.length <= maxCrops &&
      evidence.length <= maxCrops &&
      !someRegionsLackEvidence(observation);

    if (fitsRegionEvidence) {
      return {
        route: 'use_region_evidence',
        context: formatEvidenceContext(observation),
        evidence,
        observation,
      };
    }

    // Many regions OR the cropper dropped some — use a context snapshot. We
    // keep the crops we have (capped at maxCrops) so the model still gets
    // visual grounding for the parts we localized.
    return {
      route: 'use_context_snapshot',
      context: formatEvidenceContext(observation),
      evidence: evidence.slice(0, maxCrops),
      observation,
    };
  }

  // Heuristic-only labels and text-sufficient keyframes both fall through to
  // text_observation — the StateLens summary is enough and we don't waste
  // vision tokens on crops with low-trust labels.
  return {
    route: 'use_text_observation',
    context: formatEvidenceContext(observation),
    observation,
  };
}
