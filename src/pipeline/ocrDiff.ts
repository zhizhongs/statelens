// Stage 3: OCR Text Diff — DESIGN.md Section 4.4

import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import type { ChangedRegion, TextDiff } from './index.js';
import { getImageDimensions } from '../utils/image.js';

// Tesseract.js workers are stateful — concurrent recognize() calls on a single
// worker serialize internally. Maintaining a pool lets independent regions (and
// the prev/curr pair within a region) actually run in parallel. Default size
// matches the typical region count per frame (1-4) without spending CPU on
// idle workers in the common case.
function configuredPoolSize(): number {
  const raw = process.env.STATELENS_OCR_POOL_SIZE;
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= 1) return Math.min(parsed, 8);
  return 4;
}

interface OcrPool {
  acquire(): Promise<Worker>;
  release(worker: Worker): void;
  terminate(): Promise<void>;
}

interface Waiter {
  resolve: (worker: Worker) => void;
  reject: (err: unknown) => void;
}

let poolPromise: Promise<OcrPool> | null = null;

function configuredOcrLangs(): string {
  const raw = process.env.STATELENS_OCR_LANGS;
  if (typeof raw !== 'string') return 'eng';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'eng';
}

async function buildPool(): Promise<OcrPool> {
  const size = configuredPoolSize();
  const langs = configuredOcrLangs();
  const workers = await Promise.all(
    Array.from({ length: size }, () => createWorker(langs))
  );
  const available: Worker[] = [...workers];
  const waiters: Waiter[] = [];

  return {
    acquire(): Promise<Worker> {
      const worker = available.pop();
      if (worker) return Promise.resolve(worker);
      return new Promise<Worker>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    release(worker: Worker): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(worker);
      } else {
        available.push(worker);
      }
    },
    async terminate(): Promise<void> {
      // Reject any pending waiters so callers don't hang during shutdown.
      while (waiters.length > 0) {
        const w = waiters.shift();
        w?.reject(new Error('OCR pool terminated'));
      }
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

async function getPool(): Promise<OcrPool> {
  if (!poolPromise) {
    poolPromise = buildPool().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

async function recognizeWithPool(pool: OcrPool, buffer: Buffer): Promise<string> {
  const worker = await pool.acquire();
  try {
    const result = await worker.recognize(buffer);
    return result.data.text;
  } finally {
    pool.release(worker);
  }
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

export async function ocrDiff(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  regions: ChangedRegion[]
): Promise<TextDiff> {
  if (regions.length === 0) {
    return { added: [], removed: [] };
  }

  const [{ width, height }, prevDims] = await Promise.all([
    getImageDimensions(currBuffer),
    getImageDimensions(prevBuffer),
  ]);
  const pool = await getPool();
  const prevSource =
    prevDims.width === width && prevDims.height === height
      ? prevBuffer
      : await sharp(prevBuffer).resize(width, height, { fit: 'fill' }).toBuffer();

  // Run ALL regions in parallel — limited by pool size, but with size=4 a
  // typical 1-3 region frame runs fully concurrently. Each region kicks off
  // prev+curr crops + OCR; the pool handles backpressure when N regions × 2
  // recognize() calls exceed pool size.
  const regionResults = await Promise.all(
    regions.map(async (region) => {
      const cropOpts = cropForRegion(region, width, height);
      if (!cropOpts) return null;

      let prevCrop: Buffer;
      let currCrop: Buffer;
      try {
        [prevCrop, currCrop] = await Promise.all([
          sharp(prevSource).extract(cropOpts).toBuffer(),
          sharp(currBuffer).extract(cropOpts).toBuffer(),
        ]);
      } catch {
        // crop fell outside prev image bounds (mismatched dims) — skip this region.
        return null;
      }

      try {
        const [prevText, currText] = await Promise.all([
          recognizeWithPool(pool, prevCrop),
          recognizeWithPool(pool, currCrop),
        ]);
        return { prev: cleanLines(prevText), curr: cleanLines(currText) };
      } catch {
        // Region-local OCR failure — skip and continue.
        return null;
      }
    })
  );

  const prevTexts = new Set<string>();
  const currTexts = new Set<string>();
  for (const result of regionResults) {
    if (!result) continue;
    result.prev.forEach((l) => prevTexts.add(l));
    result.curr.forEach((l) => currTexts.add(l));
  }

  return {
    added: [...currTexts].filter((t) => !prevTexts.has(t)),
    removed: [...prevTexts].filter((t) => !currTexts.has(t)),
  };
}

export async function prewarmOcrWorker(): Promise<void> {
  await getPool();
}

// Exposed for tests / clean shutdown.
export async function resetOcrWorker(): Promise<void> {
  if (poolPromise) {
    const pool = await poolPromise.catch(() => null);
    poolPromise = null;
    if (pool) await pool.terminate();
  }
}
