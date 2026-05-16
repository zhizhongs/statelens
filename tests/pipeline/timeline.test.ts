import { describe, it, expect } from 'vitest';
import { SessionTimeline } from '../../src/pipeline/timeline.js';
import type { TimelineEvent } from '../../src/pipeline/index.js';

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    step: 1,
    event_type: 'text_changed',
    summary: 'something happened',
    text_diff: { added: [], removed: [] },
    regions: [],
    vlm_used: false,
    ...overrides,
  };
}

describe('SessionTimeline', () => {
  it('incrementTotal() advances total_screenshots', () => {
    const t = new SessionTimeline('s');
    t.incrementTotal();
    t.incrementTotal();
    t.incrementTotal();
    expect(t.getTimeline().total_screenshots).toBe(3);
  });

  it('addEvent() appends events and exposes them in getTimeline()', () => {
    const t = new SessionTimeline('s');
    t.incrementTotal();
    t.addEvent(event({ step: 1 }));
    t.incrementTotal();
    t.addEvent(event({ step: 2, event_type: 'ui_change' }));
    const timeline = t.getTimeline();
    expect(timeline.keyframes).toBe(2);
    expect(timeline.events.map((e) => e.event_type)).toEqual(['text_changed', 'ui_change']);
  });

  it('vlm_used events increment vlm_calls_made', () => {
    const t = new SessionTimeline('s');
    t.incrementTotal();
    t.addEvent(event({ vlm_used: true }));
    t.incrementTotal();
    t.addEvent(event({ vlm_used: false }));
    const timeline = t.getTimeline();
    expect(timeline.vlm_calls_made).toBe(1);
    expect(timeline.vlm_calls_saved).toBe(1);
  });

  it('reduction_pct is stable for zero and non-zero screenshots', () => {
    const empty = new SessionTimeline('s').getTimeline();
    expect(empty.reduction_pct).toBe(0);

    const t = new SessionTimeline('s');
    for (let i = 0; i < 10; i++) t.incrementTotal();
    t.addEvent(event({ vlm_used: true }));
    const timeline = t.getTimeline();
    // 1 VLM call out of 10 screenshots → 90.0% reduction
    expect(timeline.reduction_pct).toBe(90);
  });
});
