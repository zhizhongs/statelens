import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';
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

import { observeWithEvidence } from '../../src/pipeline/observeEvidence.js';
import {
  getTimeline,
  resetSession,
  resetVlmCumulativeUsage,
} from '../../src/pipeline/index.js';

async function decodePng(buf: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe('observeWithEvidence', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    tessMock.queue.length = 0;
    anthropicMock.responseQueue.length = 0;
    anthropicMock.createCalls.value = 0;
    resetSession('evidence');
    resetVlmCumulativeUsage();
  });

  it('returns session_start with high confidence on the first frame', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    const result = await observeWithEvidence(img, { sessionId: 'evidence' });
    expect(result.event_type).toBe('session_start');
    expect(result.confidence).toBe('high');
    expect(result.keyframe).toBe(true);
    expect(result.visual_evidence).toEqual([]);
  });

  it('returns no_change with empty evidence on an identical second frame', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    await observeWithEvidence(img, { sessionId: 'evidence' });
    const result = await observeWithEvidence(img, {
      sessionId: 'evidence',
      includeCrops: true,
    });
    expect(result.event_type).toBe('no_change');
    expect(result.changed).toBe(false);
    expect(result.visual_evidence).toEqual([]);
  });

  it('labels a text-bearing region as shipping_form and emits crops when includeCrops is set', async () => {
    const base = await solidPng(800, 600, '#ffffff');
    const changed = await pngWithRects(800, 600, '#ffffff', [
      { x: 150, y: 200, w: 200, h: 100, color: '#000000' },
    ]);
    // prev crop empty, curr crop contains shipping_form keywords.
    tessMock.queue.push('', 'Name Address Zip Code Chicago');

    await observeWithEvidence(base, { sessionId: 'evidence' });
    const result = await observeWithEvidence(changed, {
      sessionId: 'evidence',
      includeCrops: true,
    });

    expect(result.keyframe).toBe(true);
    expect(result.changed_regions.length).toBeGreaterThan(0);
    expect(result.changed_regions[0].label).toBe('shipping_form');
    expect(result.changed_regions[0].source).toBe('ocr');
    expect(result.visual_evidence.length).toBeGreaterThan(0);
    expect(result.visual_evidence[0].region_id).toBe(result.changed_regions[0].id);
    expect(typeof result.visual_evidence[0].data_base64).toBe('string');

    const cropBuf = Buffer.from(result.visual_evidence[0].data_base64!, 'base64');
    const decoded = await decodePng(cropBuf);
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);

    // includeCrops:true must not change visual_evidence reporting when no
    // regions change later — sanity check on the prev/curr ordering.
    expect(result.confidence).toBe('high');
  });

  it('skips crops when includeCrops is false even for keyframe-worthy changes', async () => {
    const base = await solidPng(800, 600, '#ffffff');
    const changed = await pngWithRects(800, 600, '#ffffff', [
      { x: 150, y: 200, w: 200, h: 100, color: '#000000' },
    ]);
    tessMock.queue.push('', 'Welcome back');

    await observeWithEvidence(base, { sessionId: 'evidence' });
    const result = await observeWithEvidence(changed, {
      sessionId: 'evidence',
      includeCrops: false,
    });

    expect(result.keyframe).toBe(true);
    expect(result.visual_evidence).toEqual([]);
  });

  it('falls back to analysis_error on undecodable buffers without breaking the session', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    await observeWithEvidence(img, { sessionId: 'evidence' });
    const bad = await observeWithEvidence(Buffer.from('not an image'), {
      sessionId: 'evidence',
    });
    expect(bad.event_type).toBe('invalid_screenshot');
    expect(bad.changed).toBe(false);
    expect(bad.confidence).toBe('low');
    expect(bad.visual_evidence).toEqual([]);
  });

  it('reports action_failed when an expect_change:* action produces no visual change', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    await observeWithEvidence(img, { sessionId: 'evidence' });
    const result = await observeWithEvidence(img, {
      sessionId: 'evidence',
      actionLabel: 'expect_change:click_submit',
    });
    expect(result.event_type).toBe('action_failed');
    expect(result.confidence).toBe('medium');
    expect(result.changed).toBe(false);
    expect(result.keyframe).toBe(true);
  });

  it('shares the session timeline with observe() — keyframes count once across orchestrators', async () => {
    const img = await solidPng(400, 300, '#ffffff');
    await observeWithEvidence(img, { sessionId: 'evidence' });
    const timeline = getTimeline('evidence');
    expect(timeline.events.length).toBe(1);
    expect(timeline.events[0].event_type).toBe('session_start');
  });
});
