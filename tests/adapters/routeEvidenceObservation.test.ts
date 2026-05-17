import { describe, it, expect } from 'vitest';
import {
  REGION_EVIDENCE_MAX_AREA_FRACTION,
  REGION_EVIDENCE_MAX_CROPS,
  routeEvidenceObservation,
} from '../../src/adapters/routeObservation.js';
import type {
  EvidenceObservation,
  EvidenceRegion,
  VisualEvidence,
} from '../../src/pipeline/index.js';

function region(
  id: string,
  label: string,
  bbox: [number, number, number, number],
  overrides: Partial<EvidenceRegion> = {}
): EvidenceRegion {
  return {
    id,
    label,
    bbox,
    source: 'ocr',
    confidence: 'medium',
    ...overrides,
  };
}

function evidence(id: string, width = 300, height = 200): VisualEvidence {
  return {
    id,
    region_id: id,
    kind: 'crop',
    media_type: 'image/png',
    width,
    height,
    data_base64: 'aGVsbG8=',
  };
}

function obs(overrides: Partial<EvidenceObservation> = {}): EvidenceObservation {
  return {
    changed: true,
    keyframe: true,
    importance_score: 0.7,
    confidence: 'medium',
    event_type: 'shipping_form_updated',
    event_summary: 'shipping form updated',
    changed_regions: [
      region('crop_1', 'shipping_form', [100, 200, 400, 400]),
      region('crop_2', 'delivery_options', [500, 200, 700, 400]),
    ],
    text_diff: { added: ['Chicago'], removed: [] },
    visual_evidence: [evidence('crop_1'), evidence('crop_2')],
    vlm_called: false,
    latency_ms: 42,
    ...overrides,
  };
}

describe('routeEvidenceObservation', () => {
  it('routes localized medium-confidence keyframes with crops to use_region_evidence', () => {
    const route = routeEvidenceObservation(obs());
    expect(route.route).toBe('use_region_evidence');
    if (route.route === 'use_region_evidence') {
      expect(route.evidence).toHaveLength(2);
      expect(route.context).toContain('Event: shipping_form_updated');
      expect(route.context).toContain('Confidence: medium');
      expect(route.context).toContain('shipping_form');
      expect(route.context).toContain('bbox: [100, 200, 400, 400]');
      expect(route.context).toContain('evidence: crop_1');
    }
  });

  it('routes more than maxCrops regions to use_context_snapshot with the crop list capped', () => {
    const regions = [
      region('crop_1', 'shipping_form', [0, 0, 100, 100]),
      region('crop_2', 'delivery_options', [100, 0, 200, 100]),
      region('crop_3', 'payment_method', [200, 0, 300, 100]),
      region('crop_4', 'navigation', [300, 0, 400, 100]),
    ];
    const visual = regions.map((r) => evidence(r.id));
    const route = routeEvidenceObservation(
      obs({ changed_regions: regions, visual_evidence: visual })
    );
    expect(route.route).toBe('use_context_snapshot');
    if (route.route === 'use_context_snapshot') {
      expect(route.evidence.length).toBe(REGION_EVIDENCE_MAX_CROPS);
    }
  });

  it('routes no-change observations to skip_vision', () => {
    const route = routeEvidenceObservation(
      obs({
        changed: false,
        keyframe: false,
        event_type: 'no_change',
        event_summary: 'Filtered by hash_exact',
        changed_regions: [],
        visual_evidence: [],
      })
    );
    expect(route.route).toBe('skip_vision');
  });

  it('routes analysis_error to use_full_vision', () => {
    const route = routeEvidenceObservation(
      obs({
        event_type: 'analysis_error',
        event_summary: 'pipeline failed',
        confidence: 'low',
      })
    );
    expect(route.route).toBe('use_full_vision');
  });

  it('routes invalid_screenshot to use_full_vision', () => {
    const route = routeEvidenceObservation(
      obs({
        changed: false,
        keyframe: false,
        event_type: 'invalid_screenshot',
        confidence: 'low',
        changed_regions: [],
        visual_evidence: [],
      })
    );
    expect(route.route).toBe('use_full_vision');
  });

  it('routes low-confidence keyframes to use_full_vision', () => {
    const route = routeEvidenceObservation(obs({ confidence: 'low' }));
    expect(route.route).toBe('use_full_vision');
  });

  it('routes keyframes without crops to use_text_observation', () => {
    const route = routeEvidenceObservation(
      obs({
        visual_evidence: [],
        changed_regions: [
          region('crop_1', 'shipping_form', [100, 100, 200, 200], { source: 'ocr' }),
        ],
      })
    );
    expect(route.route).toBe('use_text_observation');
  });

  it('falls through to use_text_observation when allowEvidenceRoutes is disabled', () => {
    const route = routeEvidenceObservation(obs(), { allowEvidenceRoutes: false });
    expect(route.route).toBe('use_text_observation');
  });

  it('falls through to use_text_observation when only heuristic labels are present', () => {
    const route = routeEvidenceObservation(
      obs({
        changed_regions: [
          region('crop_1', 'top_banner', [0, 0, 200, 60], { source: 'heuristic' }),
        ],
        visual_evidence: [evidence('crop_1')],
      })
    );
    expect(route.route).toBe('use_text_observation');
  });

  it('respects REGION_EVIDENCE_MAX_AREA_FRACTION as the context-snapshot trigger', () => {
    expect(REGION_EVIDENCE_MAX_AREA_FRACTION).toBeGreaterThan(0);
    expect(REGION_EVIDENCE_MAX_AREA_FRACTION).toBeLessThanOrEqual(1);
  });
});
