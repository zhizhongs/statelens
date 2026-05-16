// Stage 1: Cheap Visual Gate — DESIGN.md Section 4.2
// Person A: implement using sharp (resize) + crypto (md5) + pixelmatch.

import type { Buffer } from 'node:buffer';

export interface GateResult {
  changed: boolean;
  gate: string;
  distance?: number;
  diffPixels?: number;
  diffPercent?: number;
}

export async function visualGate(
  _prevBuffer: Buffer,
  _currBuffer: Buffer,
  _diffThreshold: number = 0.02
): Promise<GateResult> {
  // TODO Person A: implement per DESIGN.md Section 4.2.
  throw new Error('visualGate not implemented');
}
