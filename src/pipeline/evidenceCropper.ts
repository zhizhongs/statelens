// Crop builder for Region Evidence — docs/REGION_EVIDENCE_DESIGN.md §"Crop
// Generation". Responsible for turning EvidenceRegion[] into one image per
// region, with clamping, padding, optional overlap merge, optional resize, and
// either base64 or file-backed encoding. Crops are never persisted by default.

import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { EvidenceRegion, VisualEvidence } from './index.js';

export interface CropOptions {
  // Cap the number of crops emitted. The first N regions (after merge + sort)
  // win — order matters, so the caller should pre-sort by importance.
  maxCrops: number;
  // Longest edge of the resulting crop. Anthropic prices images by tile count,
  // so capping the long edge bounds per-crop token cost.
  maxCropEdge: number;
  // Padding in pixels added around each region so labels and context don't
  // get clipped at edges. Clamped to image bounds.
  paddingPx: number;
  encoding: 'base64' | 'file';
  // Where to write file-backed crops. Defaults to a fresh subdir under tmpdir
  // so multiple processes don't collide.
  fileDir?: string;
  // Maximum fraction of the screen any single crop may cover before we skip
  // it — those should route to context_snapshot / full_vision instead.
  maxAreaFraction?: number;
  // PNG compression level (0–9). Default 6 matches sharp's default and is
  // ~2-3x faster than level 9 with negligible size impact on small UI crops.
  // Level 9 is only worth it when bytes-on-the-wire matters more than CPU,
  // which is not the case for inline crops sent to Anthropic in-process.
  pngCompressionLevel?: number;
  // Encode as JPEG instead of PNG. Dramatically faster than PNG for typical
  // screenshots; lossy but visually fine for region evidence at q≥80.
  format?: 'png' | 'jpeg';
  jpegQuality?: number;
}

export const DEFAULT_CROP_OPTIONS: CropOptions = {
  maxCrops: 3,
  maxCropEdge: 768,
  paddingPx: 12,
  encoding: 'base64',
  maxAreaFraction: 0.45,
  pngCompressionLevel: 6,
  format: 'png',
  jpegQuality: 85,
};

interface PaddedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function padAndClamp(
  bbox: [number, number, number, number],
  padding: number,
  imageWidth: number,
  imageHeight: number
): PaddedRect | null {
  const [x1, y1, x2, y2] = bbox;
  const left = Math.max(0, Math.floor(x1 - padding));
  const top = Math.max(0, Math.floor(y1 - padding));
  const right = Math.min(imageWidth, Math.ceil(x2 + padding));
  const bottom = Math.min(imageHeight, Math.ceil(y2 + padding));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

function rectsOverlap(a: PaddedRect, b: PaddedRect): boolean {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  );
}

function unionRect(a: PaddedRect, b: PaddedRect): PaddedRect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return { left, top, width: right - left, height: bottom - top };
}

// Merge regions whose padded rects overlap. Mutation order matters because
// merging A∪B might then overlap C — we re-scan until the set is stable.
function mergeOverlapping(regions: { region: EvidenceRegion; rect: PaddedRect }[]) {
  const out = regions.map((r) => ({ region: r.region, rect: r.rect, ids: [r.region.id] }));

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (rectsOverlap(out[i].rect, out[j].rect)) {
          out[i] = {
            region: out[i].region,
            rect: unionRect(out[i].rect, out[j].rect),
            ids: [...out[i].ids, ...out[j].ids],
          };
          out.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return out;
}

// Compute the post-resize output dimensions arithmetically — avoids decoding
// the encoded PNG/JPEG just to read width/height back out (one less full
// codec round-trip per crop).
function resizedDims(
  rect: PaddedRect,
  maxCropEdge: number
): { width: number; height: number } {
  if (rect.width <= maxCropEdge && rect.height <= maxCropEdge) {
    return { width: rect.width, height: rect.height };
  }
  const scale = Math.min(
    maxCropEdge / rect.width,
    maxCropEdge / rect.height,
    1
  );
  return {
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
}

export async function buildVisualEvidence(
  screenshotBuffer: Buffer,
  regions: EvidenceRegion[],
  options: Partial<CropOptions> = {}
): Promise<VisualEvidence[]> {
  const opts: CropOptions = { ...DEFAULT_CROP_OPTIONS, ...options };
  if (regions.length === 0) return [];

  // Decode the source PNG/JPEG exactly once into a raw RGBA pixel buffer.
  // Each crop then runs `sharp(raw).extract()` which skips PNG decoding
  // entirely — for a 1920x1080 screenshot that's the difference between
  // N PNG decodes (~30-100ms each) and N near-instant extracts.
  let decoded: { data: Buffer; info: sharp.OutputInfo };
  try {
    decoded = await sharp(screenshotBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return [];
  }

  const imageWidth = decoded.info.width;
  const imageHeight = decoded.info.height;
  const channels = decoded.info.channels;
  const screenArea = Math.max(imageWidth * imageHeight, 1);
  const maxAreaFraction = opts.maxAreaFraction ?? 1;
  const compressionLevel = opts.pngCompressionLevel ?? 6;
  const format = opts.format ?? 'png';
  const jpegQuality = opts.jpegQuality ?? 85;
  const mediaType: 'image/png' | 'image/jpeg' =
    format === 'jpeg' ? 'image/jpeg' : 'image/png';

  // Pad + clamp first so overlap detection is calculated on what we'll
  // actually crop, not the raw bbox.
  const padded = regions
    .map((region) => {
      const rect = padAndClamp(region.bbox, opts.paddingPx, imageWidth, imageHeight);
      if (!rect) return null;
      const areaFraction = (rect.width * rect.height) / screenArea;
      if (areaFraction > maxAreaFraction) return null;
      return { region, rect };
    })
    .filter((entry): entry is { region: EvidenceRegion; rect: PaddedRect } => entry !== null);

  if (padded.length === 0) return [];

  const merged = mergeOverlapping(padded).slice(0, opts.maxCrops);

  const dir =
    opts.encoding === 'file'
      ? opts.fileDir ?? path.join(tmpdir(), 'statelens-evidence')
      : null;
  if (dir) await mkdir(dir, { recursive: true });

  // Encode crops in parallel. sharp releases the JS thread during work, so
  // Promise.all lets N crops run on the libuv threadpool concurrently —
  // roughly an N× speedup on multi-core machines up to UV_THREADPOOL_SIZE.
  return Promise.all(
    merged.map(async ({ region, rect }) => {
      let pipeline = sharp(decoded.data, {
        raw: { width: imageWidth, height: imageHeight, channels },
      }).extract(rect);

      if (rect.width > opts.maxCropEdge || rect.height > opts.maxCropEdge) {
        pipeline = pipeline.resize(opts.maxCropEdge, opts.maxCropEdge, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      const buffer =
        format === 'jpeg'
          ? await pipeline
              .jpeg({ quality: jpegQuality, mozjpeg: true })
              .toBuffer()
          : await pipeline
              .png({ compressionLevel, adaptiveFiltering: false })
              .toBuffer();

      const dims = resizedDims(rect, opts.maxCropEdge);
      const base: VisualEvidence = {
        id: region.id,
        region_id: region.id,
        kind: 'crop',
        media_type: mediaType,
        width: dims.width,
        height: dims.height,
      };

      if (opts.encoding === 'base64') {
        return { ...base, data_base64: buffer.toString('base64') };
      }

      const ext = format === 'jpeg' ? 'jpg' : 'png';
      const filePath = path.join(dir!, `${region.id}-${randomUUID()}.${ext}`);
      await writeFile(filePath, buffer);
      return { ...base, file_path: filePath };
    })
  );
}
