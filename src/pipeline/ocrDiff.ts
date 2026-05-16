// Stage 3: OCR Text Diff — DESIGN.md Section 4.4
// Person A: implement using tesseract.js on cropped regions (NEVER the full screenshot).

import type { Buffer } from 'node:buffer';
import type { ChangedRegion, TextDiff } from './index.js';

export async function ocrDiff(
  _prevBuffer: Buffer,
  _currBuffer: Buffer,
  _regions: ChangedRegion[]
): Promise<TextDiff> {
  // TODO Person A: implement per DESIGN.md Section 4.4.
  throw new Error('ocrDiff not implemented');
}
