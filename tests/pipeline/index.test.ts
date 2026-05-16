import { describe, it, expect, beforeEach, vi } from 'vitest';
import { solidPng, pngWithRects } from './fixtures.js';

const tessMock = vi.hoisted(() => ({
  queue: [] as string[],
}));

vi.mock('tesseract.js', () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: tessMock.queue.shift() ?? '' } }),
    terminate: async () => {},
  }),
}));

import {
  observe,
  getTimeline,
  resetSession,
  getVlmCumulativeUsage,
} from '../../src/pipeline/index.js';

describe('observe orchestrator', () => {
  beforeEach(() => {
    tessMock.queue.length = 0;
    resetSession('test');
  });

  it('returns session_start on the first frame', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    const result = await observe(img, 'test');
    expect(result.event_type).toBe('session_start');
    expect(result.keyframe).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.vlm_called).toBe(false);
  });

  it('returns no_change on an identical second frame', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    await observe(img, 'test');
    const result = await observe(img, 'test');
    expect(result.event_type).toBe('no_change');
    expect(result.changed).toBe(false);
    expect(result.keyframe).toBe(false);
    expect(result.changed_regions).toEqual([]);
  });

  it('produces regions and a non-vlm event when the frame changes', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 50, y: 40, w: 200, h: 80, color: '#000000' },
    ]);
    // OCR results for the single region: prev crop empty, curr crop "Welcome".
    tessMock.queue.push('', 'Welcome');
    await observe(base, 'test');
    const result = await observe(changed, 'test');
    expect(result.changed).toBe(true);
    expect(result.vlm_called).toBe(false);
    expect(result.changed_regions.length).toBeGreaterThan(0);
    expect(result.event_type).toBe('text_changed');
    expect(result.text_diff.added).toContain('Welcome');
  });

  it('resetSession() clears previous screenshot and timeline', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    await observe(img, 'test');
    resetSession('test');
    const timelineAfter = getTimeline('test');
    expect(timelineAfter.total_screenshots).toBe(0);
    expect(timelineAfter.events).toEqual([]);

    // Next observe is treated as a fresh session_start.
    const result = await observe(img, 'test');
    expect(result.event_type).toBe('session_start');
  });

  it('getTimeline for an unknown session returns an empty shape', () => {
    const timeline = getTimeline('never-seen');
    expect(timeline.total_screenshots).toBe(0);
    expect(timeline.events).toEqual([]);
    expect(timeline.vlm_calls_made).toBe(0);
  });

  it('VLM usage counters are zero in Phase 1', () => {
    expect(getVlmCumulativeUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});
