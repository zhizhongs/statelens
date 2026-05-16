import { Buffer } from 'node:buffer';
import sharp from 'sharp';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export async function solidPng(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

export async function pngWithRects(
  width: number,
  height: number,
  background: string,
  rects: Rect[]
): Promise<Buffer> {
  const rectsSvg = rects
    .map(
      (r) =>
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.color}" />`
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectsSvg}</svg>`;
  return sharp({
    create: { width, height, channels: 4, background },
  })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}
