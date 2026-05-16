import { describe, it, expect } from 'vitest';
import { importanceScore } from '../../src/pipeline/importanceScorer.js';
import type { ChangedRegion, TextDiff } from '../../src/pipeline/index.js';

const emptyDiff: TextDiff = { added: [], removed: [] };
const SCREEN_W = 1000;
const SCREEN_H = 1000;

function region(
  label: string,
  w: number = 100,
  h: number = 100,
  x: number = 0,
  y: number = 0
): ChangedRegion {
  return { x, y, w, h, label };
}

describe('importanceScore', () => {
  it('empty regions and empty text → score 0, not text-sufficient, no VLM', () => {
    const r = importanceScore([], emptyDiff, SCREEN_W, SCREEN_H);
    expect(r.score).toBe(0);
    expect(r.textSufficient).toBe(false);
    expect(r.shouldCallVlm).toBe(false);
  });

  it('added non-error text contributes 0.4 and is text-sufficient', () => {
    const diff: TextDiff = { added: ['Welcome back'], removed: [] };
    const r = importanceScore([], diff, SCREEN_W, SCREEN_H);
    expect(r.score).toBeCloseTo(0.4, 5);
    expect(r.textSufficient).toBe(true);
    expect(r.shouldCallVlm).toBe(false);
  });

  it('added error text contributes 0.6 and remains text-sufficient (< 0.7)', () => {
    const diff: TextDiff = { added: ['Error: invalid password'], removed: [] };
    const r = importanceScore([], diff, SCREEN_W, SCREEN_H);
    expect(r.score).toBeCloseTo(0.6, 5);
    expect(r.textSufficient).toBe(true);
    expect(r.shouldCallVlm).toBe(false);
  });

  it('added error text + large region exceeds 0.7 → not text-sufficient, calls VLM', () => {
    // Region covering > 10% of screen area.
    const big = region('content area', 400, 400);
    const diff: TextDiff = { added: ['Login failed'], removed: [] };
    const r = importanceScore([big], diff, SCREEN_W, SCREEN_H);
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.textSufficient).toBe(false);
    expect(r.shouldCallVlm).toBe(true);
  });

  it('large center modal with no text gets region + modal boost', () => {
    const modal = region('center modal', 500, 500, 250, 250);
    const r = importanceScore([modal], emptyDiff, SCREEN_W, SCREEN_H);
    // 0.3 large region + 0.1 center modal
    expect(r.score).toBeCloseTo(0.4, 5);
    expect(r.textSufficient).toBe(false);
    // 0.4 is not > 0.5, so no VLM yet — visual-only spec edge documented in
    // PIPELINE_PHASE2_IMPLEMENTATION.md.
    expect(r.shouldCallVlm).toBe(false);
  });

  it('treats invalid image dimensions as zero area contribution', () => {
    const big = region('content area', 800, 800);
    const r = importanceScore([big], emptyDiff, 0, 0);
    expect(r.score).toBe(0);
    expect(r.shouldCallVlm).toBe(false);
  });
});
