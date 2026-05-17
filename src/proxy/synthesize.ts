// Experimental fast-mode response synthesizer.
//
// In STATELENS_PROXY_FAST mode, the proxy synthesizes a response locally for
// any frame whose StateLens route says we already have a good text observation
// (skip_vision or use_text_observation). The upstream Sonnet call is skipped
// entirely — the agent receives an Anthropic-shaped Message with our
// observation as the text content.
//
// This BREAKS the v0.1.2 transparency contract: the agent expected a Sonnet
// response and gets a synthesized one. It only makes sense for agents that
// reason over free-text observations, not tool-use agents (which expect a
// tool_use block).

import type { ObservationRoute } from '../adapters/routeObservation.js';

export interface SynthesizedAnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: 'end_turn';
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function randomId(): string {
  return `msg_synth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function extractModel(body: unknown): string {
  if (body && typeof body === 'object' && 'model' in body) {
    const m = (body as { model?: unknown }).model;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return 'claude-sonnet-4-6';
}

// Pick the text the agent should see. The prefix "No meaningful change" /
// "UI state change" is intentional: it lets downstream accuracy judges
// (eval/accuracy_check.ts) recognize these frames as match-by-construction
// (visual-gate-skipped) or as our spatial/text observation, same as the
// in-process eval does. The event_summary is appended for human readability.
function formatSynthText(route: ObservationRoute): string {
  const summary = route.observation?.event_summary?.trim() ?? '';
  if (route.route === 'skip_vision') {
    return summary
      ? `No meaningful UI change detected (${summary}).`
      : 'No meaningful UI change detected.';
  }
  if (route.route === 'use_text_observation') {
    return summary
      ? `UI state changed: ${summary}`
      : 'UI state changed.';
  }
  return 'UI state changed.';
}

export interface BuildSynthesizedArgs {
  requestBody: unknown;
  route: ObservationRoute;
}

export function buildSynthesizedResponse(args: BuildSynthesizedArgs): SynthesizedAnthropicMessage {
  const { requestBody, route } = args;
  const text = formatSynthText(route);
  return {
    id: randomId(),
    type: 'message',
    role: 'assistant',
    model: extractModel(requestBody),
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    // Fast mode skipped the upstream call entirely — no Sonnet tokens were
    // consumed. The pipeline's Haiku tokens (if any) are tracked separately in
    // getVlmCumulativeUsage(), so honest cost still adds those back in.
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

// Three tiers of synth aggressiveness:
//
//   STATELENS_PROXY_SYNTH=off       (default) — never synthesize. Today's behavior.
//   STATELENS_PROXY_SYNTH=skip_only — synthesize only skip_vision frames. Safe
//                                     for accuracy because those frames are
//                                     visually identical to the prior frame;
//                                     the agent would have gotten a near-empty
//                                     Sonnet response anyway.
//   STATELENS_PROXY_SYNTH=all       — synthesize skip_vision + use_text_observation.
//                                     Aggressive: agent loses the Sonnet
//                                     description on changed frames. Breaks
//                                     tool-use agents.
//
// STATELENS_PROXY_FAST=1 is kept as an alias for STATELENS_PROXY_SYNTH=all to
// preserve the earlier experimental name.
type SynthMode = 'off' | 'skip_only' | 'all';

function readSynthMode(): SynthMode {
  if (process.env.STATELENS_PROXY_FAST === '1') return 'all';
  const raw = (process.env.STATELENS_PROXY_SYNTH ?? '').toLowerCase().trim();
  if (raw === 'all') return 'all';
  if (raw === 'skip_only' || raw === 'skip-only') return 'skip_only';
  return 'off';
}

export function isFastModeEnabled(): boolean {
  return readSynthMode() !== 'off';
}

// Routes safe to synthesize given the current synth mode. use_full_vision
// MUST still hit Sonnet because the agent explicitly needs the model to see
// the image.
export function shouldSynthesizeRoute(route: ObservationRoute): boolean {
  const mode = readSynthMode();
  if (mode === 'off') return false;
  if (route.route === 'skip_vision') return true;
  if (mode === 'all' && route.route === 'use_text_observation') return true;
  return false;
}
