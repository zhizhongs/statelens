// Stage 3: OCR Text Diff — DESIGN.md Section 4.4

import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import type { ChangedRegion, TextDiff } from './index.js';
import { getImageDimensions } from '../utils/image.js';

let workerPromise: Promise<Worker> | null = null;

function configuredOcrLangs(): string {
  const raw = process.env.STATELENS_OCR_LANGS;
  if (typeof raw !== 'string') return 'eng';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'eng';
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(configuredOcrLangs()).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function cleanLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) =>
      line
        .normalize('NFKC')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
    )
    .filter((line) => line.length > 0);
}

function cropForRegion(
  region: ChangedRegion,
  width: number,
  height: number
): { left: number; top: number; width: number; height: number } | null {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(width, Math.ceil(region.x + region.w));
  const bottom = Math.min(height, Math.ceil(region.y + region.h));
  const cropW = right - left;
  const cropH = bottom - top;

  if (left >= width || top >= height || cropW <= 0 || cropH <= 0) {
    return null;
  }

  return { left, top, width: cropW, height: cropH };
}

// Per-region OCR results. `byRegion` is index-aligned with the input `regions`
// array (skipped regions get an empty entry) so callers — like the Region
// Evidence labeler — can attach text to specific bboxes. `added`/`removed`
// preserve the legacy aggregated shape for backward compatibility.
export interface OcrDiffDetail {
  added: string[];
  removed: string[];
  byRegion: { prev: string[]; curr: string[] }[];
}

export async function ocrDiffDetailed(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  regions: ChangedRegion[]
): Promise<OcrDiffDetail> {
  if (regions.length === 0) {
    return { added: [], removed: [], byRegion: [] };
  }

  const [{ width, height }, prevDims] = await Promise.all([
    getImageDimensions(currBuffer),
    getImageDimensions(prevBuffer),
  ]);
  const worker = await getWorker();
  const prevSource =
    prevDims.width === width && prevDims.height === height
      ? prevBuffer
      : await sharp(prevBuffer).resize(width, height, { fit: 'fill' }).toBuffer();

  const prevTexts = new Set<string>();
  const currTexts = new Set<string>();
  const byRegion: { prev: string[]; curr: string[] }[] = regions.map(() => ({
    prev: [],
    curr: [],
  }));

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const cropOpts = cropForRegion(region, width, height);
    if (!cropOpts) continue;

    let prevCrop: Buffer;
    let currCrop: Buffer;
    try {
      [prevCrop, currCrop] = await Promise.all([
        sharp(prevSource).extract(cropOpts).toBuffer(),
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
      const prevLines = cleanLines(prevResult.data.text);
      const currLines = cleanLines(currResult.data.text);
      byRegion[i] = { prev: prevLines, curr: currLines };
      prevLines.forEach((l) => prevTexts.add(l));
      currLines.forEach((l) => currTexts.add(l));
    } catch {
      // Region-local OCR failure — skip and continue.
      continue;
    }
  }

  return {
    added: [...currTexts].filter((t) => !prevTexts.has(t)),
    removed: [...prevTexts].filter((t) => !currTexts.has(t)),
    byRegion,
  };
}

export async function ocrDiff(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  regions: ChangedRegion[]
): Promise<TextDiff> {
  const detailed = await ocrDiffDetailed(prevBuffer, currBuffer, regions);
  return { added: detailed.added, removed: detailed.removed };
}

export async function prewarmOcrWorker(): Promise<void> {
  await getWorker();
}

// Exposed for tests / clean shutdown.
export async function resetOcrWorker(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    if (w) await w.terminate();
  }
}
