import type { ObservationRoute } from '../adapters/routeObservation.js';
import type {
  EvidenceObservation,
  ObservationResult,
  VisualEvidence,
} from '../pipeline/index.js';
import {
  replaceAnthropicImageBlockWithBlocks,
  replaceAnthropicImageBlockWithText,
} from './anthropicImageBlocks.js';
import type {
  ExtractedImageBlock,
  GatewayRewriteResult,
} from './types.js';

function formatList(label: string, values: string[]): string | null {
  if (!values.length) return null;
  return `${label}: ${values.map((v) => JSON.stringify(v)).join(', ')}`;
}

function isEvidenceObservation(
  observation: ObservationResult | EvidenceObservation
): observation is EvidenceObservation {
  return (
    'visual_evidence' in observation &&
    Array.isArray((observation as EvidenceObservation).visual_evidence)
  );
}

export function formatObservationText(
  observation: ObservationResult | EvidenceObservation
): string {
  const lines = [
    'StateLens observation for the latest UI screenshot:',
    `Event: ${observation.event_type}`,
    `Summary: ${observation.event_summary}`,
  ];

  if (isEvidenceObservation(observation)) {
    lines.push(`Confidence: ${observation.confidence}`);
  } else if (observation.confidence) {
    lines.push(`Confidence: ${observation.confidence}`);
  }

  const added = formatList('Text appeared', observation.text_diff.added);
  const removed = formatList('Text disappeared', observation.text_diff.removed);
  if (added) lines.push(added);
  if (removed) lines.push(removed);

  if (observation.changed_regions.length) {
    if (isEvidenceObservation(observation)) {
      lines.push('Changed regions:');
      observation.changed_regions.forEach((region, index) => {
        lines.push(`${index + 1}. ${region.label}, bbox: [${region.bbox.join(', ')}]`);
      });
    } else {
      const labels = [...new Set(observation.changed_regions.map((r) => r.label))];
      lines.push(`Regions changed: ${labels.join(', ')}`);
    }
  }

  lines.push('');
  lines.push(
    'The screenshot image was removed to save vision tokens. Use this observation as the UI state for this turn unless the task explicitly requires raw visual inspection.'
  );

  return lines.join('\n');
}

export function formatNoChangeText(
  observation: ObservationResult | EvidenceObservation
): string {
  return [
    'StateLens observation for the latest UI screenshot:',
    `Event: ${observation.event_type || 'no_change'}`,
    'Summary: No meaningful UI change was detected since the previous screenshot in this StateLens session.',
    '',
    'The screenshot image was removed to save vision tokens. Continue from the prior UI state unless the task explicitly requires raw visual inspection.',
  ].join('\n');
}

export function formatEvidenceObservationText(
  observation: EvidenceObservation,
  contextLabel: 'region_evidence' | 'context_snapshot'
): string {
  const lines: string[] = [
    'StateLens observation for the latest UI screenshot:',
    `Event: ${observation.event_type}`,
    `Summary: ${observation.event_summary}`,
    `Confidence: ${observation.confidence}`,
  ];

  const added = formatList('Text appeared', observation.text_diff.added);
  const removed = formatList('Text disappeared', observation.text_diff.removed);
  if (added) lines.push(added);
  if (removed) lines.push(removed);

  if (observation.changed_regions.length) {
    lines.push('Changed regions:');
    observation.changed_regions.forEach((region, index) => {
      const evidenceId =
        observation.visual_evidence.find((ev) => ev.region_id === region.id)?.id;
      const evidenceSuffix = evidenceId ? `, evidence: ${evidenceId}` : '';
      lines.push(
        `${index + 1}. ${region.label}, bbox: [${region.bbox.join(', ')}]${evidenceSuffix}`
      );
    });
  }

  lines.push('');
  if (contextLabel === 'region_evidence') {
    lines.push(
      'The full screenshot was removed to save vision tokens. The attached crops are the changed regions only.'
    );
  } else {
    lines.push(
      'The full screenshot was downscaled or partially summarized to save vision tokens. The attached crops cover the most important changed regions.'
    );
  }

  return lines.join('\n');
}

function buildCropImageBlocks(evidence: VisualEvidence[]) {
  // Only base64-encoded crops can ride the Anthropic message body. File-backed
  // crops would require an upload first, which is out of scope for the proxy
  // rewrite — fall back to text-only routes if base64 data is missing.
  return evidence
    .filter((ev) => typeof ev.data_base64 === 'string' && ev.data_base64.length > 0)
    .map((ev) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: ev.media_type,
        data: ev.data_base64,
      },
    }));
}

function shouldForwardUnchanged(route: ObservationRoute): string | null {
  const observation = route.observation;
  if (observation.event_type === 'session_start') {
    return 'session_start needs full visual grounding';
  }
  if (
    observation.event_type === 'invalid_screenshot' ||
    observation.event_type === 'analysis_error'
  ) {
    return `pipeline returned ${observation.event_type}`;
  }
  if (route.route === 'use_full_vision') {
    return route.reason;
  }
  return null;
}

export function rewriteAnthropicRequestForRoute(args: {
  requestBody: unknown;
  image: ExtractedImageBlock | null;
  route: ObservationRoute;
}): GatewayRewriteResult {
  const { requestBody, image, route } = args;

  if (!image) {
    return {
      action: 'forward_unchanged',
      reason: 'no supported screenshot image block found',
      requestBody,
      observation: route.observation,
      route,
    };
  }

  const unchangedReason = shouldForwardUnchanged(route);
  if (unchangedReason) {
    return {
      action: 'forward_unchanged',
      reason: unchangedReason,
      requestBody,
      observation: route.observation,
      route,
    };
  }

  if (route.route === 'use_region_evidence' || route.route === 'use_context_snapshot') {
    const cropBlocks = buildCropImageBlocks(route.evidence);
    if (cropBlocks.length === 0) {
      // No usable crops (e.g. file-only encoding). Fall back to the text-only
      // rewrite — the model still gets the StateLens summary, just without
      // image evidence.
      return {
        action: 'forward_rewritten',
        reason: `${route.route}:text_fallback`,
        requestBody: replaceAnthropicImageBlockWithText(
          requestBody,
          image,
          formatObservationText(route.observation)
        ),
        observation: route.observation,
        route,
      };
    }

    const text = formatEvidenceObservationText(
      route.observation,
      route.route === 'use_region_evidence' ? 'region_evidence' : 'context_snapshot'
    );
    return {
      action: 'forward_rewritten',
      reason: route.route,
      requestBody: replaceAnthropicImageBlockWithBlocks(requestBody, image, [
        { type: 'text', text },
        ...cropBlocks,
      ]),
      observation: route.observation,
      route,
    };
  }

  const replacementText =
    route.route === 'skip_vision'
      ? formatNoChangeText(route.observation)
      : formatObservationText(route.observation);

  return {
    action: 'forward_rewritten',
    reason: route.route,
    requestBody: replaceAnthropicImageBlockWithText(requestBody, image, replacementText),
    observation: route.observation,
    route,
  };
}

