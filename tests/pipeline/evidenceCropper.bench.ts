// Vitest benchmark suite for the Region Evidence cropper. Run with:
//   npx vitest bench tests/pipeline/evidenceCropper.bench.ts
//
// Not part of the default `npm test` pass — these benchmarks allocate large
// raw buffers (a 1920x1080 RGBA decode is ~8MB) and intentionally do real
// PNG/JPEG encoding to compare format and concurrency cost.

import { Buffer } from 'node:buffer';
import { bench, describe } from 'vitest';
import sharp from 'sharp';
import { buildVisualEvidence } from '../../src/pipeline/evidenceCropper.js';
import type { EvidenceRegion } from '../../src/pipeline/index.js';
import { pngWithRects } from './fixtures.js';

const WIDTH = 1920;
const HEIGHT = 1080;

const regions: EvidenceRegion[] = [
  {
    id: 'crop_1',
    label: 'shipping_form',
    bbox: [120, 220, 620, 520],
    source: 'ocr',
    confidence: 'medium',
  },
  {
    id: 'crop_2',
    label: 'delivery_options',
    bbox: [700, 300, 1100, 540],
    source: 'ocr',
    confidence: 'medium',
  },
  {
    id: 'crop_3',
    label: 'payment_method',
    bbox: [200, 700, 800, 950],
    source: 'ocr',
    confidence: 'medium',
  },
];

// Build a screenshot with enough rectangular structure that PNG compression
// has actual work to do — a flat solid image is trivially RLE-compressible
// and understates the real workload.
async function buildBusyScreenshot(): Promise<Buffer> {
  const rects = [] as { x: number; y: number; w: number; h: number; color: string }[];
  const colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b'];
  for (let i = 0; i < 200; i++) {
    const x = Math.floor(Math.random() * WIDTH);
    const y = Math.floor(Math.random() * HEIGHT);
    const w = 20 + Math.floor(Math.random() * 220);
    const h = 10 + Math.floor(Math.random() * 60);
    rects.push({ x, y, w, h, color: colors[i % colors.length] });
  }
  return pngWithRects(WIDTH, HEIGHT, '#fefefe', rects);
}

// Pre-optimization baseline: serial loop, PNG level 9, re-decode source per
// crop, metadata round-trip per crop. Used to quantify the speedup the new
// implementation gives.
async function buildVisualEvidenceLegacy(
  screenshotBuffer: Buffer,
  regs: EvidenceRegion[]
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const region of regs) {
    const [x1, y1, x2, y2] = region.bbox;
    const rect = {
      left: x1,
      top: y1,
      width: x2 - x1,
      height: y2 - y1,
    };
    const buffer = await sharp(screenshotBuffer)
      .extract(rect)
      .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const meta = await sharp(buffer).metadata();
    out.push({
      id: region.id,
      width: meta.width,
      height: meta.height,
      data_base64: buffer.toString('base64'),
    });
  }
  return out;
}

let screenshot: Buffer;

describe('buildVisualEvidence — 3 crops, 1920x1080 busy screenshot', async () => {
  screenshot = await buildBusyScreenshot();

  bench('legacy: serial, PNG level 9, re-decode per crop', async () => {
    await buildVisualEvidenceLegacy(screenshot, regions);
  });

  bench('current: parallel, PNG level 6, single decode', async () => {
    await buildVisualEvidence(screenshot, regions, {
      maxCrops: 3,
      maxCropEdge: 768,
      paddingPx: 12,
      encoding: 'base64',
    });
  });

  bench('current: parallel, PNG level 9, single decode', async () => {
    await buildVisualEvidence(screenshot, regions, {
      maxCrops: 3,
      maxCropEdge: 768,
      paddingPx: 12,
      encoding: 'base64',
      pngCompressionLevel: 9,
    });
  });

  bench('current: parallel, JPEG q85, single decode', async () => {
    await buildVisualEvidence(screenshot, regions, {
      maxCrops: 3,
      maxCropEdge: 768,
      paddingPx: 12,
      encoding: 'base64',
      format: 'jpeg',
      jpegQuality: 85,
    });
  });
});
