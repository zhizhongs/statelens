import { describe, it, expect } from 'vitest';
import { visualGate } from '../../src/pipeline/visualGate.js';
import { solidPng, pngWithRects } from './fixtures.js';

describe('visualGate', () => {
  it('returns hash_exact for identical buffers', async () => {
    const a = await solidPng(800, 600, '#ffffff');
    const result = await visualGate(a, a);
    expect(result.changed).toBe(false);
    expect(result.gate).toBe('hash_exact');
    expect(result.distance).toBe(0);
  });

  it('returns pixelmatch for tiny diff below threshold', async () => {
    const base = await solidPng(800, 600, '#ffffff');
    // 8x8 pixel speck on otherwise identical image. After 640x360 normalization
    // this is well under 2% of pixels.
    const tweaked = await pngWithRects(800, 600, '#ffffff', [
      { x: 0, y: 0, w: 8, h: 8, color: '#000000' },
    ]);
    const result = await visualGate(base, tweaked);
    expect(result.changed).toBe(false);
    expect(result.gate).toBe('pixelmatch');
    expect(result.diffPercent).toBeLessThan(0.02);
  });

  it('returns passed for large diff above threshold', async () => {
    const a = await solidPng(800, 600, '#ffffff');
    const b = await solidPng(800, 600, '#000000');
    const result = await visualGate(a, b);
    expect(result.changed).toBe(true);
    expect(result.gate).toBe('passed');
    expect(result.diffPercent).toBeGreaterThan(0.02);
  });
});
