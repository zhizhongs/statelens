import { describe, it, expect } from 'vitest';
import {
  aggregateConfidence,
  confidenceForRegion,
  regionLabeler,
} from '../../src/pipeline/regionLabeler.js';
import { bboxFromRegion } from '../../src/pipeline/index.js';

describe('bboxFromRegion', () => {
  it('converts { x, y, w, h } to [x1, y1, x2, y2]', () => {
    expect(bboxFromRegion({ x: 10, y: 20, w: 30, h: 40 })).toEqual([10, 20, 40, 60]);
  });

  it('rounds fractional inputs to integer pixel coordinates', () => {
    expect(bboxFromRegion({ x: 10.4, y: 20.6, w: 30.1, h: 40.7 })).toEqual([
      10, 21, 41, 61,
    ]);
  });
});

describe('confidenceForRegion', () => {
  it('returns high when OCR is reliable, label has a non-heuristic source, and region count is small', () => {
    expect(
      confidenceForRegion({
        ocrReliable: true,
        labelSource: 'ocr',
        regionCount: 2,
        areaFraction: 0.1,
      })
    ).toBe('high');
  });

  it('drops to low when OCR is noisy and the label fell back to geometry', () => {
    expect(
      confidenceForRegion({
        ocrReliable: false,
        labelSource: 'heuristic',
        regionCount: 1,
        areaFraction: 0.05,
      })
    ).toBe('low');
  });

  it('drops to low when many regions are fragmented', () => {
    expect(
      confidenceForRegion({
        ocrReliable: true,
        labelSource: 'ocr',
        regionCount: 7,
        areaFraction: 0.02,
      })
    ).toBe('low');
  });

  it('drops to low when a single region covers most of the screen', () => {
    expect(
      confidenceForRegion({
        ocrReliable: true,
        labelSource: 'mixed',
        regionCount: 1,
        areaFraction: 0.8,
      })
    ).toBe('low');
  });

  it('returns medium in the in-between case', () => {
    expect(
      confidenceForRegion({
        ocrReliable: true,
        labelSource: 'mixed',
        regionCount: 4,
        areaFraction: 0.1,
      })
    ).toBe('medium');
  });
});

describe('aggregateConfidence', () => {
  it('returns low when any region is low', () => {
    expect(aggregateConfidence(['high', 'low', 'medium'])).toBe('low');
  });
  it('returns high only when every region is high', () => {
    expect(aggregateConfidence(['high', 'high', 'high'])).toBe('high');
    expect(aggregateConfidence(['high', 'medium', 'high'])).toBe('medium');
  });
  it('returns low for an empty input', () => {
    expect(aggregateConfidence([])).toBe('low');
  });
});

describe('regionLabeler', () => {
  it('labels shipping_form via OCR keywords (address, zip)', () => {
    const { regions, confidence } = regionLabeler({
      regions: [{ x: 100, y: 100, w: 300, h: 200, label: 'content area' }],
      ocrTextByRegion: [['Name', 'Address', 'Zip Code', 'Chicago']],
      imageWidth: 1024,
      imageHeight: 768,
    });
    expect(regions).toHaveLength(1);
    expect(regions[0].label).toBe('shipping_form');
    expect(regions[0].source).toBe('ocr');
    expect(regions[0].bbox).toEqual([100, 100, 400, 300]);
    expect(regions[0].text).toEqual(['Name', 'Address', 'Zip Code', 'Chicago']);
    expect(confidence).toBe('high');
  });

  it('labels delivery_options when shipping method keywords match', () => {
    const { regions } = regionLabeler({
      regions: [{ x: 700, y: 200, w: 280, h: 320, label: 'right panel' }],
      ocrTextByRegion: [['Delivery', 'Tuesday', 'Express']],
      imageWidth: 1024,
      imageHeight: 768,
    });
    expect(regions[0].label).toBe('delivery_options');
  });

  it('labels payment_method for card / cvv text', () => {
    const { regions } = regionLabeler({
      regions: [{ x: 50, y: 400, w: 400, h: 200, label: 'content area' }],
      ocrTextByRegion: [['Card number', 'CVV', 'Expiration']],
      imageWidth: 1024,
      imageHeight: 768,
    });
    expect(regions[0].label).toBe('payment_method');
  });

  it('labels login_form for username / password text', () => {
    const { regions } = regionLabeler({
      regions: [{ x: 300, y: 250, w: 400, h: 300, label: 'center modal' }],
      ocrTextByRegion: [['Username', 'Password', 'Sign in']],
      imageWidth: 1024,
      imageHeight: 768,
    });
    expect(regions[0].label).toBe('login_form');
  });

  it('labels error_message ahead of navigation when both match', () => {
    const { regions } = regionLabeler({
      regions: [{ x: 0, y: 0, w: 1024, h: 60, label: 'top banner' }],
      ocrTextByRegion: [['Submit failed: required field invalid']],
      imageWidth: 1024,
      imageHeight: 768,
    });
    expect(regions[0].label).toBe('error_message');
  });

  it('falls back to a snake_case geometry label when OCR is missing', () => {
    const { regions, confidence } = regionLabeler({
      regions: [{ x: 0, y: 0, w: 1024, h: 60, label: 'top banner' }],
      ocrTextByRegion: [[]],
      imageWidth: 1024,
      imageHeight: 768,
    });
    expect(regions[0].label).toBe('top_banner');
    expect(regions[0].source).toBe('heuristic');
    expect(confidence).toBe('low');
  });

  it('marks source as mixed when OCR is unreliable but geometry still names the region', () => {
    const { regions } = regionLabeler({
      regions: [{ x: 100, y: 100, w: 200, h: 100, label: 'content area' }],
      // Single-character symbol noise — passes nothing through the reliability gate.
      ocrTextByRegion: [['a / ® |']],
      imageWidth: 1024,
      imageHeight: 768,
    });
    expect(regions[0].label).toBe('content_area');
    expect(regions[0].source).toBe('heuristic');
  });

  it('VLM hints win over OCR labels and downgrade aggregate confidence when the hint says low', () => {
    const hints = new Map<number, { label?: string; confidence?: 'low' | 'medium' | 'high' }>();
    hints.set(0, { label: 'custom_thing', confidence: 'low' });
    const { regions } = regionLabeler({
      regions: [{ x: 0, y: 0, w: 200, h: 200, label: 'content area' }],
      ocrTextByRegion: [['Name', 'Address']],
      imageWidth: 800,
      imageHeight: 600,
      vlmRegionHints: hints,
    });
    expect(regions[0].label).toBe('custom_thing');
    expect(regions[0].source).toBe('mixed');
    expect(regions[0].confidence).toBe('low');
  });

  it('aggregates per-region confidences into the observation-level confidence', () => {
    const { confidence } = regionLabeler({
      regions: [
        { x: 0, y: 0, w: 100, h: 100, label: 'top banner' },
        { x: 200, y: 200, w: 100, h: 100, label: 'content area' },
      ],
      ocrTextByRegion: [['Welcome back'], []],
      imageWidth: 1024,
      imageHeight: 768,
    });
    expect(confidence).toBe('low');
  });
});
