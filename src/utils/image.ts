// Image utilities — sharp helpers used across pipeline stages.

import type { Buffer } from 'node:buffer';

export interface ImageDimensions {
  width: number;
  height: number;
}

export async function getImageDimensions(_buffer: Buffer): Promise<ImageDimensions> {
  // TODO Person A: sharp(buffer).metadata() -> { width, height }
  throw new Error('getImageDimensions not implemented');
}
