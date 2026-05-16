import { describe, it, expect } from 'vitest';
import { spatialDiff, classifyRegion } from '../../src/pipeline/spatialDiff.js';
import { solidPng, pngWithRects } from './fixtures.js';

describe('spatialDiff', () => {
  it('returns [] when there is no change', async () => {
    const a = await solidPng(400, 300, '#ffffff');
    const regions = await spatialDiff(a, a, 50);
    expect(regions).toEqual([]);
  });

  it('returns one region for a single changed rectangle', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 50, y: 40, w: 100, h: 60, color: '#000000' },
    ]);
    const regions = await spatialDiff(base, changed, 100);
    expect(regions.length).toBe(1);
    const r = regions[0];
    // Bounding box should roughly cover the painted rectangle.
    expect(r.x).toBeLessThanOrEqual(55);
    expect(r.y).toBeLessThanOrEqual(45);
    expect(r.w).toBeGreaterThan(80);
    expect(r.h).toBeGreaterThan(40);
    expect(typeof r.label).toBe('string');
  });

  it('returns two sorted regions for two separated rectangles', async () => {
    const base = await solidPng(400, 300, '#ffffff');
    const changed = await pngWithRects(400, 300, '#ffffff', [
      { x: 20, y: 30, w: 80, h: 50, color: '#000000' },
      { x: 250, y: 200, w: 80, h: 50, color: '#000000' },
    ]);
    const regions = await spatialDiff(base, changed, 100);
    expect(regions.length).toBe(2);
    // Sorted by y, then x.
    expect(regions[0].y).toBeLessThan(regions[1].y);
  });

  it('returns a single large region for a full-screen change', async () => {
    const a = await solidPng(400, 300, '#ffffff');
    const b = await solidPng(400, 300, '#000000');
    const regions = await spatialDiff(a, b, 500);
    expect(regions.length).toBe(1);
    expect(regions[0].w).toBeGreaterThan(300);
    expect(regions[0].h).toBeGreaterThan(200);
  });
});

describe('classifyRegion', () => {
  it('labels top banner', () => {
    expect(classifyRegion({ x: 0, y: 0, w: 400, h: 30 }, 400, 300)).toBe('top banner');
  });
  it('labels bottom bar', () => {
    expect(classifyRegion({ x: 0, y: 280, w: 400, h: 20 }, 400, 300)).toBe('bottom bar');
  });
  it('labels center modal', () => {
    expect(classifyRegion({ x: 50, y: 50, w: 300, h: 200 }, 400, 300)).toBe('center modal');
  });
});
