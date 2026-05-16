// Stage 3: OCR Text Diff — DESIGN.md Section 4.4

import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import type { ChangedRegion, TextDiff } from './index.js';
import { getImageDimensions } from '../utils/image.js';

let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng');
  }
  return workerPromise;
}

function cleanLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0);
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

export async function ocrDiff(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  regions: ChangedRegion[]
): Promise<TextDiff> {
  if (regions.length === 0) {
    return { added: [], removed: [] };
  }

  const { width, height } = await getImageDimensions(currBuffer);
  const worker = await getWorker();

  const prevTexts = new Set<string>();
  const currTexts = new Set<string>();

  for (const region of regions) {
    const left = clamp(region.x, 0, Math.max(0, width - 1));
    const top = clamp(region.y, 0, Math.max(0, height - 1));
    const cropW = clamp(region.w, 1, width - left);
    const cropH = clamp(region.h, 1, height - top);
    const cropOpts = { left, top, width: cropW, height: cropH };

    let prevCrop: Buffer;
    let currCrop: Buffer;
    try {
      [prevCrop, currCrop] = await Promise.all([
        sharp(prevBuffer).extract(cropOpts).toBuffer(),
        sharp(currBuffer).extract(cropOpts).toBuffer(),
      ]);
    } catch {
      // crop fell outside prev image bounds (mismatched dims) — skip this region.
      continue;
    }

    try {
      const [prevResult, currResult] = await Promise.all([
        worker.recognize(prevCrop),
        worker.recognize(currCrop),
      ]);
      cleanLines(prevResult.data.text).forEach((l) => prevTexts.add(l));
      cleanLines(currResult.data.text).forEach((l) => currTexts.add(l));
    } catch {
      // Region-local OCR failure — skip and continue.
      continue;
    }
  }

  return {
    added: [...currTexts].filter((t) => !prevTexts.has(t)),
    removed: [...prevTexts].filter((t) => !currTexts.has(t)),
  };
}

// Exposed for tests / clean shutdown.
export async function resetOcrWorker(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    if (w) await w.terminate();
  }
}
