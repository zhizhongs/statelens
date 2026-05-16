import { describe, it, expect, beforeEach, vi } from 'vitest';
import { solidPng, pngWithRects } from './fixtures.js';

const tessMock = vi.hoisted(() => ({
  queue: [] as string[],
}));

const anthropicMock = vi.hoisted(() => ({
  responseQueue: [] as Array<unknown>,
  createCalls: { value: 0 },
}));

vi.mock('tesseract.js', () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: tessMock.queue.shift() ?? '' } }),
    terminate: async () => {},
  }),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: async () => {
        anthropicMock.createCalls.value++;
        const next = anthropicMock.responseQueue.shift();
        if (next instanceof Error) throw next;
        if (!next) throw new Error('MockAnthropic: no queued response');
        return next;
      },
    };
  }
  return { default: MockAnthropic };
});

import {
  observe,
  getTimeline,
  resetSession,
  getVlmCumulativeUsage,
  resetVlmCumulativeUsage,
} from '../../src/pipeline/index.js';

function queueVlmResponse(
  payload: { event_type: string; summary: string; important_text?: string[] },
  usage = { input_tokens: 1000, output_tokens: 50 }
) {
  anthropicMock.responseQueue.push({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage,
  });
}

describe('observe orchestrator', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    tessMock.queue.length = 0;
    anthropicMock.responseQueue.length = 0;
    anthropicMock.createCalls.value = 0;
    resetSession('test');
    resetVlmCumulativeUsage();
  });

  it('returns session_start on the first frame', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    const result = await observe(img, 'test');
    expect(result.event_type).toBe('session_start');
    expect(result.keyframe).toBe(true);
    expect(result.vlm_called).toBe(false);
  });

  it('returns a structured invalid_screenshot observation and preserves prior state', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    await observe(img, 'test');

    const bad = await observe(Buffer.from('not an image'), 'test');
    expect(bad.event_type).toBe('invalid_screenshot');
    expect(bad.changed).toBe(false);
    expect(bad.keyframe).toBe(false);

    const after = await observe(img, 'test');
    expect(after.event_type).toBe('no_change');
    expect(getTimeline('test').events.length).toBe(1);
  });

  it('returns no_change on an identical second frame and does not add a timeline event', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    await observe(img, 'test');
    const result = await observe(img, 'test');
    expect(result.event_type).toBe('no_change');
    expect(result.changed).toBe(false);
    expect(result.keyframe).toBe(false);
    // Only the session_start event should have been recorded.
    const timeline = getTimeline('test');
    expect(timeline.events.length).toBe(1);
    expect(timeline.events[0].event_type).toBe('session_start');
  });

  it('returns minor_change for a low-score visual diff without adding a timeline event', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    // Region large enough to pass the 2% Stage 1 gate but well under the 10%
    // Stage 4 area boost, with no OCR text → score = 0 → minor_change.
    // 100x80 = 8000 px = 6.7% of 400x300.
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 60, y: 60, w: 100, h: 80, color: '#000000' },
    ]);
    // No OCR text — both crops are empty so textDiff.added is empty.
    tessMock.queue.push('', '');
    await observe(base, 'test');
    const result = await observe(changed, 'test');
    expect(result.changed).toBe(true);
    expect(result.keyframe).toBe(false);
    expect(result.event_type).toBe('minor_change');
    expect(result.vlm_called).toBe(false);

    const timeline = getTimeline('test');
    // session_start only; the minor_change should not be appended.
    expect(timeline.events.length).toBe(1);
  });

  it('text-sufficient change returns a keyframe with vlm_called: false', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    // 100x50 = 5000 px = 4.2% of screen → stays under the 10% area boost so
    // score sticks at 0.4 (text only) → textSufficient = true → no VLM.
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 80, y: 80, w: 100, h: 50, color: '#000000' },
    ]);
    // OCR: prev crop empty, curr crop has plain (non-error) text.
    tessMock.queue.push('', 'Welcome back');
    await observe(base, 'test');
    const result = await observe(changed, 'test');
    expect(result.keyframe).toBe(true);
    expect(result.vlm_called).toBe(false);
    expect(result.event_type).toBe('text_appeared');
    expect(result.text_diff.added).toContain('Welcome back');
    expect(anthropicMock.createCalls.value).toBe(0);
  });

  it('high-score not-text-sufficient change calls vlmExplain and returns vlm_called: true', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    // Big region (> 10% of screen) so the region boost stacks on the error
    // keyword boost and pushes score past 0.7 → textSufficient = false,
    // shouldCallVlm = true.
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 20, y: 20, w: 360, h: 260, color: '#aa0000' },
    ]);
    tessMock.queue.push('', 'Error: invalid password');
    queueVlmResponse({
      event_type: 'error_appeared',
      summary: 'Invalid password error shown',
      important_text: ['Error: invalid password'],
    });
    await observe(base, 'test');
    const result = await observe(changed, 'test');
    expect(result.vlm_called).toBe(true);
    expect(result.event_type).toBe('error_appeared');
    expect(result.event_summary).toContain('Invalid password');
    expect(anthropicMock.createCalls.value).toBe(1);

    const timeline = getTimeline('test');
    expect(timeline.vlm_calls_made).toBe(1);
  });

  it('falls back to a local keyframe when VLM returns malformed JSON after usage is counted', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 20, y: 20, w: 360, h: 260, color: '#aa0000' },
    ]);
    tessMock.queue.push('', 'Error: invalid password');
    anthropicMock.responseQueue.push({
      content: [{ type: 'text', text: 'not json' }],
      usage: { input_tokens: 222, output_tokens: 9 },
    });

    await observe(base, 'test');
    const result = await observe(changed, 'test');
    expect(result.keyframe).toBe(true);
    expect(result.event_type).toBe('error_appeared');
    expect(result.event_summary).toContain('VLM explanation unavailable');
    expect(result.vlm_called).toBe(true);
    expect(getVlmCumulativeUsage()).toEqual({ input_tokens: 222, output_tokens: 9 });
    expect(getTimeline('test').vlm_calls_made).toBe(1);
  });

  it('getVlmCumulativeUsage() proxies the Stage 5 counter; resetVlmCumulativeUsage() clears it', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 20, y: 20, w: 360, h: 260, color: '#aa0000' },
    ]);
    tessMock.queue.push('', 'Error: login failed');
    queueVlmResponse(
      { event_type: 'error_appeared', summary: 'login failed', important_text: [] },
      { input_tokens: 750, output_tokens: 25 }
    );

    expect(getVlmCumulativeUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
    await observe(base, 'test');
    await observe(changed, 'test');
    expect(getVlmCumulativeUsage()).toEqual({ input_tokens: 750, output_tokens: 25 });

    resetVlmCumulativeUsage();
    expect(getVlmCumulativeUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('resetSession() clears screenshot history but does not clear VLM usage', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 20, y: 20, w: 360, h: 260, color: '#aa0000' },
    ]);
    tessMock.queue.push('', 'Error: invalid token');
    queueVlmResponse(
      { event_type: 'error_appeared', summary: 'token invalid', important_text: [] },
      { input_tokens: 333, output_tokens: 11 }
    );
    await observe(base, 'test');
    await observe(changed, 'test');
    expect(getVlmCumulativeUsage()).toEqual({ input_tokens: 333, output_tokens: 11 });

    resetSession('test');
    expect(getTimeline('test').total_screenshots).toBe(0);
    // Global VLM counter must NOT have been reset.
    expect(getVlmCumulativeUsage()).toEqual({ input_tokens: 333, output_tokens: 11 });
  });

  it('getTimeline for an unknown session returns an empty shape', () => {
    const timeline = getTimeline('never-seen');
    expect(timeline.total_screenshots).toBe(0);
    expect(timeline.events).toEqual([]);
    expect(timeline.vlm_calls_made).toBe(0);
  });
});
