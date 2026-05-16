import { describe, it, expect } from 'vitest';
import { estimateRouteSavings, routeObservation } from '../../src/adapters/routeObservation.js';
import type { ObservationResult } from '../../src/pipeline/index.js';

function obs(overrides: Partial<ObservationResult> = {}): ObservationResult {
  return {
    changed: true,
    keyframe: true,
    importance_score: 0.7,
    event_type: 'ui_change',
    event_summary: 'UI changed',
    changed_regions: [],
    text_diff: { added: [], removed: [] },
    vlm_called: false,
    latency_ms: 10,
    ...overrides,
  };
}

describe('routeObservation', () => {
  it('routes no-change observations to skip_vision', () => {
    const result = routeObservation(
      obs({ changed: false, keyframe: false, event_type: 'no_change', event_summary: 'Filtered by hash_exact' })
    );
    expect(result.route).toBe('skip_vision');
    if (result.route === 'skip_vision') expect(result.reason).toMatch(/no_change/i);
  });

  it('routes minor_change (changed but not keyframe) to skip_vision', () => {
    const result = routeObservation(
      obs({ keyframe: false, importance_score: 0.1, event_type: 'minor_change', event_summary: 'Minor visual change' })
    );
    expect(result.route).toBe('skip_vision');
    if (result.route === 'skip_vision') expect(result.reason).toMatch(/minor_change/);
  });

  it('routes a text-sufficient keyframe to use_text_observation with formatted context', () => {
    const result = routeObservation(
      obs({
        event_type: 'text_appeared',
        event_summary: 'Text appeared: "Welcome back"',
        text_diff: { added: ['Welcome back'], removed: [] },
        changed_regions: [{ x: 10, y: 10, w: 50, h: 20, label: 'top-left banner' }],
        vlm_called: false,
      })
    );
    expect(result.route).toBe('use_text_observation');
    if (result.route === 'use_text_observation') {
      expect(result.context).toContain('Event: text_appeared');
      expect(result.context).toContain('Welcome back');
      expect(result.context).toContain('top-left banner');
    }
  });

  it('routes a vlm-explained keyframe to use_text_observation (StateLens summary is enough)', () => {
    const result = routeObservation(
      obs({
        event_type: 'error_appeared',
        event_summary: 'Invalid password error shown',
        vlm_called: true,
        text_diff: { added: ['Invalid password'], removed: [] },
      })
    );
    expect(result.route).toBe('use_text_observation');
  });

  it('routes invalid_screenshot conservatively to use_full_vision', () => {
    const result = routeObservation(
      obs({
        changed: false,
        keyframe: false,
        event_type: 'invalid_screenshot',
        event_summary: 'Could not decode',
      })
    );
    expect(result.route).toBe('use_full_vision');
    if (result.route === 'use_full_vision') expect(result.reason).toMatch(/invalid_screenshot/);
  });

  it('routes analysis_error conservatively to use_full_vision', () => {
    const result = routeObservation(
      obs({
        event_type: 'analysis_error',
        event_summary: 'Pipeline failed',
      })
    );
    expect(result.route).toBe('use_full_vision');
    if (result.route === 'use_full_vision') expect(result.reason).toMatch(/analysis_error/);
  });

  it('always passes the observation through unchanged', () => {
    const o = obs({ changed: false, keyframe: false, event_type: 'no_change' });
    const result = routeObservation(o);
    expect(result.observation).toBe(o);
  });

  it('estimates downstream screenshot tokens saved from route decisions', () => {
    const routes = [
      routeObservation(obs({ changed: false, keyframe: false, event_type: 'no_change' })),
      routeObservation(obs({ event_type: 'text_appeared', text_diff: { added: ['Hi'], removed: [] } })),
      routeObservation(obs({ event_type: 'analysis_error' })),
    ];

    expect(estimateRouteSavings(routes, 1000)).toEqual({
      total_observations: 3,
      downstream_vision_calls: 1,
      downstream_vision_calls_saved: 2,
      estimated_downstream_input_tokens_saved: 2000,
      assumed_tokens_per_screenshot: 1000,
    });
  });
});
