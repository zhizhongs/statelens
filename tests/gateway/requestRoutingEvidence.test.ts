import { describe, expect, it } from 'vitest';
import type { ObservationRoute } from '../../src/adapters/routeObservation.js';
import {
  formatEvidenceObservationText,
  rewriteAnthropicRequestForRoute,
} from '../../src/gateway/requestRouting.js';
import { extractLatestAnthropicImageBlock } from '../../src/gateway/anthropicImageBlocks.js';
import type {
  EvidenceObservation,
  VisualEvidence,
} from '../../src/pipeline/index.js';

const SCREENSHOT_B64 = Buffer.from('screenshot').toString('base64');
const CROP_B64 = Buffer.from('crop-bytes').toString('base64');

function bodyWithImage() {
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what changed?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: SCREENSHOT_B64 },
          },
        ],
      },
    ],
  };
}

function visualEvidence(id: string, data: string = CROP_B64): VisualEvidence {
  return {
    id,
    region_id: id,
    kind: 'crop',
    media_type: 'image/png',
    width: 200,
    height: 150,
    data_base64: data,
  };
}

function evidenceObservation(): EvidenceObservation {
  return {
    changed: true,
    keyframe: true,
    importance_score: 0.72,
    confidence: 'medium',
    event_type: 'shipping_form_updated',
    event_summary: 'User entered address details and selected delivery method.',
    changed_regions: [
      {
        id: 'crop_1',
        label: 'shipping_form',
        bbox: [120, 220, 620, 510],
        source: 'mixed',
        confidence: 'medium',
        text: ['Name', 'Address'],
      },
      {
        id: 'crop_2',
        label: 'delivery_options',
        bbox: [640, 300, 980, 520],
        source: 'mixed',
        confidence: 'medium',
        text: ['Tuesday'],
      },
    ],
    text_diff: { added: ['Chicago', 'Tuesday'], removed: [] },
    visual_evidence: [visualEvidence('crop_1'), visualEvidence('crop_2')],
    vlm_called: true,
    latency_ms: 812,
  };
}

describe('gateway request rewriting with region evidence', () => {
  it('formats evidence observation text with confidence and bbox/evidence ids', () => {
    const text = formatEvidenceObservationText(evidenceObservation(), 'region_evidence');
    expect(text).toContain('Event: shipping_form_updated');
    expect(text).toContain('Confidence: medium');
    expect(text).toContain('shipping_form, bbox: [120, 220, 620, 510], evidence: crop_1');
    expect(text).toContain('delivery_options, bbox: [640, 300, 980, 520], evidence: crop_2');
    expect(text).toContain('The attached crops are the changed regions only');
  });

  it('rewrites use_region_evidence requests to text + crop image blocks', () => {
    const request = bodyWithImage();
    const observation = evidenceObservation();
    const route: ObservationRoute = {
      route: 'use_region_evidence',
      context: 'context',
      evidence: observation.visual_evidence,
      observation,
    };

    const result = rewriteAnthropicRequestForRoute({
      requestBody: request,
      image: extractLatestAnthropicImageBlock(request),
      route,
    });

    expect(result.action).toBe('forward_rewritten');
    const content = (result.requestBody as any).messages[0].content;
    expect(content).toHaveLength(4);
    expect(content[0]).toEqual({ type: 'text', text: 'what changed?' });
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain('Event: shipping_form_updated');
    expect(content[1].text).toContain('Confidence: medium');
    expect(content[2]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: CROP_B64 },
    });
    expect(content[3].type).toBe('image');
  });

  it('rewrites use_context_snapshot like region_evidence but with the snapshot framing copy', () => {
    const request = bodyWithImage();
    const observation = evidenceObservation();
    const route: ObservationRoute = {
      route: 'use_context_snapshot',
      context: 'context',
      evidence: observation.visual_evidence,
      observation,
    };

    const result = rewriteAnthropicRequestForRoute({
      requestBody: request,
      image: extractLatestAnthropicImageBlock(request),
      route,
    });

    expect(result.action).toBe('forward_rewritten');
    const content = (result.requestBody as any).messages[0].content;
    expect(content[1].text).toContain('partially summarized');
    expect(content[2].type).toBe('image');
  });

  it('falls back to a text-only rewrite when crops only exist as files', () => {
    const request = bodyWithImage();
    const observation = evidenceObservation();
    const fileBacked = observation.visual_evidence.map((ev) => ({
      ...ev,
      data_base64: undefined,
      file_path: '/tmp/crop.png',
    }));
    const route: ObservationRoute = {
      route: 'use_region_evidence',
      context: 'context',
      evidence: fileBacked,
      observation: { ...observation, visual_evidence: fileBacked },
    };

    const result = rewriteAnthropicRequestForRoute({
      requestBody: request,
      image: extractLatestAnthropicImageBlock(request),
      route,
    });

    expect(result.action).toBe('forward_rewritten');
    expect(result.reason).toBe('use_region_evidence:text_fallback');
    const content = (result.requestBody as any).messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[1].type).toBe('text');
  });

  it('still falls through to use_full_vision for analysis errors', () => {
    const request = bodyWithImage();
    const observation: EvidenceObservation = {
      ...evidenceObservation(),
      event_type: 'analysis_error',
      visual_evidence: [],
    };
    const route: ObservationRoute = {
      route: 'use_full_vision',
      reason: 'analysis_error',
      observation,
    };

    const result = rewriteAnthropicRequestForRoute({
      requestBody: request,
      image: extractLatestAnthropicImageBlock(request),
      route,
    });

    expect(result.action).toBe('forward_unchanged');
  });
});
