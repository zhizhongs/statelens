import { describe, expect, it } from 'vitest';
import {
  bboxFromRegion,
  buildVisualEvidence,
  captureAndRoute,
  confidenceForRegion,
  DEFAULT_CROP_OPTIONS,
  estimateRouteSavings,
  observe,
  observeWithEvidence,
  regionLabeler,
  REGION_EVIDENCE_MAX_AREA_FRACTION,
  REGION_EVIDENCE_MAX_CROPS,
  routeEvidenceObservation,
  routeObservation,
  SEMANTIC_LABELS,
} from '../src/library.js';

describe('public library exports', () => {
  it('exposes the pipeline, routing helper, and in-process adapter from one entrypoint', () => {
    expect(typeof observe).toBe('function');
    expect(typeof routeObservation).toBe('function');
    expect(typeof estimateRouteSavings).toBe('function');
    expect(typeof captureAndRoute).toBe('function');
  });

  it('exposes the Region Evidence API surface', () => {
    expect(typeof observeWithEvidence).toBe('function');
    expect(typeof routeEvidenceObservation).toBe('function');
    expect(typeof regionLabeler).toBe('function');
    expect(typeof confidenceForRegion).toBe('function');
    expect(typeof buildVisualEvidence).toBe('function');
    expect(typeof bboxFromRegion).toBe('function');
    expect(SEMANTIC_LABELS.shipping_form).toBeDefined();
    expect(DEFAULT_CROP_OPTIONS.maxCrops).toBeGreaterThan(0);
    expect(REGION_EVIDENCE_MAX_CROPS).toBeGreaterThan(0);
    expect(REGION_EVIDENCE_MAX_AREA_FRACTION).toBeGreaterThan(0);
  });
});

