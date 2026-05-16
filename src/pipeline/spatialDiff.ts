// Stage 2: Spatial Diff Localization — DESIGN.md Section 4.3
// Person A: implement using pixelmatch diff image + connected component analysis.

import type { Buffer } from 'node:buffer';
import type { ChangedRegion } from './index.js';

export async function spatialDiff(
  _prevBuffer: Buffer,
  _currBuffer: Buffer,
  _minArea: number = 500
): Promise<ChangedRegion[]> {
  // TODO Person A: implement per DESIGN.md Section 4.3.
  throw new Error('spatialDiff not implemented');
}

export function classifyRegion(
  region: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number
): string {
  const centerX = region.x + region.w / 2;
  const centerY = region.y + region.h / 2;
  const relX = centerX / imgW;
  const relY = centerY / imgH;
  const area = (region.w * region.h) / (imgW * imgH);

  if (area > 0.3 && relX > 0.2 && relX < 0.8 && relY > 0.2 && relY < 0.8)
    return 'center modal';
  if (relY < 0.15) return 'top banner';
  if (relY > 0.85) return 'bottom bar';
  if (relX < 0.25) return 'left sidebar';
  if (relX > 0.75) return 'right panel';
  return 'content area';
}
