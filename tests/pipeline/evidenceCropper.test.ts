import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildVisualEvidence } from '../../src/pipeline/evidenceCropper.js';
import type { EvidenceRegion } from '../../src/pipeline/index.js';
import { solidPng } from './fixtures.js';

function region(
  id: string,
  bbox: [number, number, number, number],
  overrides: Partial<EvidenceRegion> = {}
): EvidenceRegion {
  return {
    id,
    label: 'content_area',
    bbox,
    source: 'mixed',
    confidence: 'medium',
    ...overrides,
  };
}

async function decodePng(buf: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe('buildVisualEvidence', () => {
  it('returns [] when no regions are supplied', async () => {
    const screenshot = await solidPng(200, 100, '#ffffff');
    const result = await buildVisualEvidence(screenshot, []);
    expect(result).toEqual([]);
  });

  it('returns [] when the buffer is not a decodable image', async () => {
    const result = await buildVisualEvidence(
      Buffer.from('not an image'),
      [region('crop_1', [0, 0, 50, 50])]
    );
    expect(result).toEqual([]);
  });

  it('produces a base64 PNG per region with the expected id and shape', async () => {
    const screenshot = await solidPng(800, 600, '#ffffff');
    const regions = [
      region('crop_1', [100, 100, 300, 300]),
      region('crop_2', [400, 400, 600, 500]),
    ];
    const evidence = await buildVisualEvidence(screenshot, regions, {
      maxCrops: 3,
      maxCropEdge: 1024,
      paddingPx: 0,
      encoding: 'base64',
    });
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      id: 'crop_1',
      region_id: 'crop_1',
      kind: 'crop',
      media_type: 'image/png',
    });
    expect(typeof evidence[0].data_base64).toBe('string');
    expect(evidence[0].data_base64?.length).toBeGreaterThan(0);

    const decoded = await decodePng(Buffer.from(evidence[0].data_base64!, 'base64'));
    expect(decoded.width).toBe(200);
    expect(decoded.height).toBe(200);
  });

  it('pads and clamps crops to the screenshot bounds', async () => {
    const screenshot = await solidPng(400, 300, '#ffffff');
    const evidence = await buildVisualEvidence(
      screenshot,
      [region('crop_1', [380, 280, 400, 300])],
      { maxCrops: 1, maxCropEdge: 1024, paddingPx: 20, encoding: 'base64' }
    );
    const decoded = await decodePng(Buffer.from(evidence[0].data_base64!, 'base64'));
    // Padding pushes the box past the right/bottom edge — must clamp at the
    // screenshot size, not over-extend.
    expect(decoded.width).toBeLessThanOrEqual(400);
    expect(decoded.height).toBeLessThanOrEqual(300);
    // And the padded box should be larger than the original 20x20 bbox.
    expect(decoded.width).toBeGreaterThanOrEqual(20);
    expect(decoded.height).toBeGreaterThanOrEqual(20);
  });

  it('respects maxCrops and drops extra regions', async () => {
    const screenshot = await solidPng(600, 400, '#ffffff');
    const regions = [
      region('crop_1', [0, 0, 50, 50]),
      region('crop_2', [100, 100, 150, 150]),
      region('crop_3', [200, 200, 250, 250]),
      region('crop_4', [300, 300, 350, 350]),
    ];
    const evidence = await buildVisualEvidence(screenshot, regions, {
      maxCrops: 2,
      maxCropEdge: 1024,
      paddingPx: 0,
      encoding: 'base64',
    });
    expect(evidence).toHaveLength(2);
    expect(evidence.map((e) => e.id)).toEqual(['crop_1', 'crop_2']);
  });

  it('resizes crops larger than maxCropEdge', async () => {
    const screenshot = await solidPng(1600, 1200, '#ffffff');
    const evidence = await buildVisualEvidence(
      screenshot,
      // Single region just inside the max-area-fraction guardrail so the
      // resize path is what we're actually exercising.
      [region('crop_1', [200, 200, 1400, 900])],
      {
        maxCrops: 1,
        maxCropEdge: 256,
        paddingPx: 0,
        encoding: 'base64',
        maxAreaFraction: 1,
      }
    );
    const decoded = await decodePng(Buffer.from(evidence[0].data_base64!, 'base64'));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(256);
  });

  it('skips crops that cover more than maxAreaFraction of the screen', async () => {
    const screenshot = await solidPng(400, 300, '#ffffff');
    const evidence = await buildVisualEvidence(
      screenshot,
      [region('crop_1', [0, 0, 380, 280])],
      {
        maxCrops: 1,
        maxCropEdge: 1024,
        paddingPx: 0,
        encoding: 'base64',
        maxAreaFraction: 0.3,
      }
    );
    expect(evidence).toEqual([]);
  });

  it('merges overlapping regions into one crop', async () => {
    const screenshot = await solidPng(600, 400, '#ffffff');
    const evidence = await buildVisualEvidence(
      screenshot,
      [
        region('crop_1', [100, 100, 200, 200]),
        region('crop_2', [150, 150, 250, 250]),
      ],
      { maxCrops: 5, maxCropEdge: 1024, paddingPx: 0, encoding: 'base64' }
    );
    expect(evidence).toHaveLength(1);
    const decoded = await decodePng(Buffer.from(evidence[0].data_base64!, 'base64'));
    expect(decoded.width).toBeGreaterThanOrEqual(150);
    expect(decoded.height).toBeGreaterThanOrEqual(150);
  });

  it('writes crops to disk in file mode and returns the path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'statelens-cropper-test-'));
    try {
      const screenshot = await solidPng(400, 300, '#ffffff');
      const evidence = await buildVisualEvidence(
        screenshot,
        [region('crop_1', [10, 10, 110, 110])],
        {
          maxCrops: 1,
          maxCropEdge: 1024,
          paddingPx: 0,
          encoding: 'file',
          fileDir: dir,
        }
      );
      expect(evidence[0].file_path).toBeDefined();
      expect(evidence[0].data_base64).toBeUndefined();
      const bytes = await readFile(evidence[0].file_path!);
      const decoded = await decodePng(bytes);
      expect(decoded.width).toBe(100);
      expect(decoded.height).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
