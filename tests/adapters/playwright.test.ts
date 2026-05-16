import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Buffer } from 'node:buffer';
import { solidPng, pngWithRects } from '../pipeline/fixtures.js';

// Mock the same external services the pipeline test mocks so we are exercising
// the real observe() pipeline through the adapter, end-to-end, without
// touching the network or the OCR worker.
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

import { captureAndRoute, type PlaywrightLikePage } from '../../src/adapters/playwright.js';
import { resetSession, resetVlmCumulativeUsage } from '../../src/pipeline/index.js';

class StubPage implements PlaywrightLikePage {
  private idx = 0;
  constructor(private readonly frames: Buffer[]) {}
  async screenshot(): Promise<Buffer> {
    const next = this.frames[Math.min(this.idx, this.frames.length - 1)];
    this.idx++;
    return next;
  }
}

describe('captureAndRoute (Playwright reference adapter)', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    tessMock.queue.length = 0;
    anthropicMock.responseQueue.length = 0;
    anthropicMock.createCalls.value = 0;
    resetSession('pw-test');
    resetVlmCumulativeUsage();
  });

  it('returns use_text_observation on the first frame (session_start)', async () => {
    const frame = await solidPng(400, 300, '#ffffff');
    const page = new StubPage([frame]);

    const result = await captureAndRoute(page, { sessionId: 'pw-test', actionLabel: 'navigate' });

    expect(result.route.route).toBe('use_text_observation');
    expect(result.observation.event_type).toBe('session_start');
    expect(result.screenshot).toBe(frame);
  });

  it('routes an unchanged second frame to skip_vision and never calls the downstream VLM', async () => {
    const frame = await solidPng(400, 300, '#ffffff');
    const page = new StubPage([frame, frame]);
    const callDownstreamVlm = vi.fn(async () => 'should not happen');

    // Frame 1 — session_start
    const first = await captureAndRoute(page, { sessionId: 'pw-test' });
    if (first.route.route === 'use_full_vision') await callDownstreamVlm();

    // Frame 2 — identical image, should be killed by the visual gate
    const second = await captureAndRoute(page, { sessionId: 'pw-test', actionLabel: 'noop' });
    if (second.route.route === 'use_full_vision') await callDownstreamVlm();

    expect(second.route.route).toBe('skip_vision');
    expect(second.observation.changed).toBe(false);
    expect(callDownstreamVlm).not.toHaveBeenCalled();
    // StateLens internal VLM also untouched.
    expect(anthropicMock.createCalls.value).toBe(0);
  });

  it('routes a text-sufficient keyframe to use_text_observation with usable context', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    const after = await pngWithRects(400, 300, '#ffffff', [
      { x: 80, y: 80, w: 100, h: 50, color: '#000000' },
    ]);
    tessMock.queue.push('', 'Welcome back');
    const page = new StubPage([base, after]);
    const callDownstreamVlm = vi.fn(async () => 'should not happen');

    await captureAndRoute(page, { sessionId: 'pw-test' });
    const second = await captureAndRoute(page, { sessionId: 'pw-test', actionLabel: 'click_login' });
    if (second.route.route === 'use_full_vision') await callDownstreamVlm();

    expect(second.route.route).toBe('use_text_observation');
    if (second.route.route === 'use_text_observation') {
      expect(second.route.context).toContain('Welcome back');
      expect(second.route.context).toContain('text_appeared');
    }
    expect(callDownstreamVlm).not.toHaveBeenCalled();
    // No Stage 5 call: text alone explained the change.
    expect(anthropicMock.createCalls.value).toBe(0);
  });

  it('forwards screenshotOptions to page.screenshot()', async () => {
    const frame = await solidPng(400, 300, '#ffffff');
    const screenshot = vi.fn(async () => frame);
    const page: PlaywrightLikePage = { screenshot };

    await captureAndRoute(page, {
      sessionId: 'pw-test',
      screenshotOptions: { fullPage: true, clip: { x: 0, y: 0, width: 400, height: 300 } },
    });

    expect(screenshot).toHaveBeenCalledTimes(1);
    const opts = screenshot.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.type).toBe('png');
    expect(opts.fullPage).toBe(true);
    expect(opts.clip).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });
});
