// Stage 1: Cheap Visual Gate — DESIGN.md Section 4.2

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';

export interface GateResult {
  changed: boolean;
  gate: string;
  distance?: number;
  diffPixels?: number;
  diffPercent?: number;
}

const GATE_WIDTH = 640;
const GATE_HEIGHT = 360;

async function normalize(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(GATE_WIDTH, GATE_HEIGHT, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

export async function visualGate(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  diffThreshold: number = 0.02
): Promise<GateResult> {
  const [prev, curr] = await Promise.all([normalize(prevBuffer), normalize(currBuffer)]);

  const prevHash = createHash('md5').update(prev).digest('hex');
  const currHash = createHash('md5').update(curr).digest('hex');
  if (prevHash === currHash) {
    return { changed: false, gate: 'hash_exact', distance: 0 };
  }

  const diff = Buffer.alloc(GATE_WIDTH * GATE_HEIGHT * 4);
  const diffPixels = pixelmatch(prev, curr, diff, GATE_WIDTH, GATE_HEIGHT, { threshold: 0.1 });
  const diffPercent = diffPixels / (GATE_WIDTH * GATE_HEIGHT);

  if (diffPercent < diffThreshold) {
    return { changed: false, gate: 'pixelmatch', diffPixels, diffPercent };
  }
  return { changed: true, gate: 'passed', diffPixels, diffPercent };
}
