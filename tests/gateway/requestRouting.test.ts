import { describe, expect, it } from 'vitest';
import type { ObservationRoute } from '../../src/adapters/routeObservation.js';
import {
  formatNoChangeText,
  formatObservationText,
  rewriteAnthropicRequestForRoute,
} from '../../src/gateway/requestRouting.js';
import { extractLatestAnthropicImageBlock } from '../../src/gateway/anthropicImageBlocks.js';
import type { ObservationResult } from '../../src/pipeline/index.js';

const IMG = Buffer.from('image').toString('base64');

function body() {
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } },
        ],
      },
    ],
  };
}

function obs(overrides: Partial<ObservationResult> = {}): ObservationResult {
  return {
    changed: true,
    keyframe: true,
    importance_score: 0.7,
    event_type: 'text_appeared',
    event_summary: 'Welcome text appeared',
    changed_regions: [{ x: 1, y: 2, w: 3, h: 4, label: 'content area' }],
    text_diff: { added: ['Welcome'], removed: [] },
    vlm_called: false,
    latency_ms: 10,
    ...overrides,
  };
}

function route(routeName: ObservationRoute['route'], observation = obs()): ObservationRoute {
  if (routeName === 'skip_vision') {
    return { route: 'skip_vision', reason: 'skip', observation };
  }
  if (routeName === 'use_full_vision') {
    return { route: 'use_full_vision', reason: 'full', observation };
  }
  return { route: 'use_text_observation', context: 'Event: text_appeared', observation };
}

describe('gateway request routing', () => {
  it('formats text observations for replacement blocks', () => {
    const text = formatObservationText(obs());
    expect(text).toContain('Event: text_appeared');
    expect(text).toContain('Welcome text appeared');
    expect(text).toContain('Text appeared: "Welcome"');
    expect(text).toContain('content area');
  });

  it('formats no-change observations for replacement blocks', () => {
    const text = formatNoChangeText(obs({ changed: false, keyframe: false, event_type: 'no_change' }));
    expect(text).toContain('Event: no_change');
    expect(text).toContain('No meaningful UI change');
  });

  it('forwards unchanged when no image is available', () => {
    const result = rewriteAnthropicRequestForRoute({
      requestBody: body(),
      image: null,
      route: route('use_text_observation'),
    });
    expect(result.action).toBe('forward_unchanged');
  });

  it('forwards session_start unchanged', () => {
    const request = body();
    const result = rewriteAnthropicRequestForRoute({
      requestBody: request,
      image: extractLatestAnthropicImageBlock(request),
      route: route('use_text_observation', obs({ event_type: 'session_start' })),
    });
    expect(result.action).toBe('forward_unchanged');
  });

  it('forwards analysis failures unchanged', () => {
    const request = body();
    const result = rewriteAnthropicRequestForRoute({
      requestBody: request,
      image: extractLatestAnthropicImageBlock(request),
      route: route('use_full_vision', obs({ event_type: 'analysis_error' })),
    });
    expect(result.action).toBe('forward_unchanged');
  });

  it('rewrites text observations', () => {
    const request = body();
    const result = rewriteAnthropicRequestForRoute({
      requestBody: request,
      image: extractLatestAnthropicImageBlock(request),
      route: route('use_text_observation'),
    });
    expect(result.action).toBe('forward_rewritten');
    expect((result.requestBody as any).messages[0].content[1].type).toBe('text');
    expect((result.requestBody as any).messages[0].content[1].text).toContain('Welcome text appeared');
  });

  it('rewrites skip_vision observations as no-change text', () => {
    const request = body();
    const result = rewriteAnthropicRequestForRoute({
      requestBody: request,
      image: extractLatestAnthropicImageBlock(request),
      route: route('skip_vision', obs({ changed: false, keyframe: false, event_type: 'no_change' })),
    });
    expect(result.action).toBe('forward_rewritten');
    expect((result.requestBody as any).messages[0].content[1].text).toContain('No meaningful UI change');
  });
});

