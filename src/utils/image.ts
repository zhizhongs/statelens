// Image utilities — sharp helpers used across pipeline stages.

import type { Buffer } from 'node:buffer';
import sharp from 'sharp';

export interface ImageDimensions {
  width: number;
  height: number;
}

export async function getImageDimensions(buffer: Buffer): Promise<ImageDimensions> {
  const meta = await sharp(buffer).metadata();
  if (typeof meta.width !== 'number' || typeof meta.height !== 'number') {
    throw new Error('getImageDimensions: sharp could not determine image dimensions');
  }
  return { width: meta.width, height: meta.height };
}
