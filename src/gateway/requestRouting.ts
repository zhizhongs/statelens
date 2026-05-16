import type { ObservationRoute } from '../adapters/routeObservation.js';
import type { ObservationResult } from '../pipeline/index.js';
import { replaceAnthropicImageBlockWithText } from './anthropicImageBlocks.js';
import type {
  ExtractedImageBlock,
  GatewayRewriteResult,
} from './types.js';

function formatList(label: string, values: string[]): string | null {
  if (!values.length) return null;
  return `${label}: ${values.map((v) => JSON.stringify(v)).join(', ')}`;
}

export function formatObservationText(observation: ObservationResult): string {
  const lines = [
    'StateLens observation for the latest UI screenshot:',
    `Event: ${observation.event_type}`,
    `Summary: ${observation.event_summary}`,
  ];

  const added = formatList('Text appeared', observation.text_diff.added);
  const removed = formatList('Text disappeared', observation.text_diff.removed);
  if (added) lines.push(added);
  if (removed) lines.push(removed);

  if (observation.changed_regions.length) {
    const labels = [...new Set(observation.changed_regions.map((r) => r.label))];
    lines.push(`Regions changed: ${labels.join(', ')}`);
  }

  lines.push('');
  lines.push(
    'The screenshot image was removed to save vision tokens. Use this observation as the UI state for this turn unless the task explicitly requires raw visual inspection.'
  );

  return lines.join('\n');
}

export function formatNoChangeText(observation: ObservationResult): string {
  return [
    'StateLens observation for the latest UI screenshot:',
    `Event: ${observation.event_type || 'no_change'}`,
    'Summary: No meaningful UI change was detected since the previous screenshot in this StateLens session.',
    '',
    'The screenshot image was removed to save vision tokens. Continue from the prior UI state unless the task explicitly requires raw visual inspection.',
  ].join('\n');
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

