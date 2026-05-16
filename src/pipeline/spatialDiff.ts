// Stage 2: Spatial Diff Localization — DESIGN.md Section 4.3

import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import type { ChangedRegion } from './index.js';
import { getImageDimensions } from '../utils/image.js';

export async function spatialDiff(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  minArea: number = 500
): Promise<ChangedRegion[]> {
  const { width, height } = await getImageDimensions(currBuffer);

  const [prev, curr] = await Promise.all([
    sharp(prevBuffer).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer(),
    sharp(currBuffer).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer(),
  ]);

  const diff = Buffer.alloc(width * height * 4);
  pixelmatch(prev, curr, diff, width, height, { threshold: 0.1 });

  const components = findComponents(diff, width, height, minArea);
  return components
    .map((c) => {
      const w = c.maxX - c.minX + 1;
      const h = c.maxY - c.minY + 1;
      return {
        x: c.minX,
        y: c.minY,
        w,
        h,
        label: classifyRegion({ x: c.minX, y: c.minY, w, h }, width, height),
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

interface Component {
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function isChanged(diff: Buffer, pixelIdx: number): boolean {
  const o = pixelIdx * 4;
  return diff[o] > 200 && diff[o + 1] < 80 && diff[o + 2] < 80 && diff[o + 3] > 0;
}

function findComponents(diff: Buffer, width: number, height: number, minArea: number): Component[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total); // packed (y * width + x) indices
  const components: Component[] = [];

  for (let startY = 0; startY < height; startY++) {
    for (let startX = 0; startX < width; startX++) {
      const startIdx = startY * width + startX;
      if (visited[startIdx]) continue;
      if (!isChanged(diff, startIdx)) {
        visited[startIdx] = 1;
        continue;
      }

      visited[startIdx] = 1;
      stack[0] = startIdx;
      let top = 1;

      let count = 0;
      let minX = startX;
      let minY = startY;
      let maxX = startX;
      let maxY = startY;

      while (top > 0) {
        top--;
        const idx = stack[top];
        const x = idx % width;
        const y = (idx - x) / width;
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;

        // 4-neighbors
        if (x > 0) {
          const nIdx = idx - 1;
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            if (isChanged(diff, nIdx)) {
              stack[top++] = nIdx;
            }
          }
        }
        if (x < width - 1) {
          const nIdx = idx + 1;
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            if (isChanged(diff, nIdx)) {
              stack[top++] = nIdx;
            }
          }
        }
        if (y > 0) {
          const nIdx = idx - width;
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            if (isChanged(diff, nIdx)) {
              stack[top++] = nIdx;
            }
          }
        }
        if (y < height - 1) {
          const nIdx = idx + width;
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            if (isChanged(diff, nIdx)) {
              stack[top++] = nIdx;
            }
          }
        }
      }

      if (count >= minArea) {
        components.push({ count, minX, minY, maxX, maxY });
      }
    }
  }

  return components;
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
