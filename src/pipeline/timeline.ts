// Stage 6: Session Timeline Assembly — DESIGN.md Section 4.7
// Person A: per-session event log + cost metrics.

import { Buffer } from 'node:buffer';
import type { TimelineEvent, TimelineResult } from './index.js';

export class SessionTimeline {
  sessionId: string;
  events: TimelineEvent[] = [];
  totalScreenshots = 0;
  vlmCalls = 0;
  private prevScreenshot: Buffer | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  getPrevScreenshot(): Buffer | null {
    return this.prevScreenshot;
  }

  setPrevScreenshot(buf: Buffer): void {
    this.prevScreenshot = Buffer.from(buf);
  }

  addEvent(event: TimelineEvent): void {
    this.events.push(event);
    if (event.vlm_used) this.vlmCalls++;
  }

  incrementTotal(): void {
    this.totalScreenshots++;
  }

  getTimeline(): TimelineResult {
    const reductionPct = this.totalScreenshots > 0
      ? Math.round((1 - this.vlmCalls / this.totalScreenshots) * 1000) / 10
      : 0;
    return {
      session_id: this.sessionId,
      total_screenshots: this.totalScreenshots,
      keyframes: this.events.length,
      vlm_calls_made: this.vlmCalls,
      vlm_calls_saved: this.totalScreenshots - this.vlmCalls,
      reduction_pct: reductionPct,
      estimated_tokens_saved: (this.totalScreenshots - this.vlmCalls) * 1200,
      events: this.events.map((event) => ({
        ...event,
        text_diff: {
          added: [...event.text_diff.added],
          removed: [...event.text_diff.removed],
        },
        regions: event.regions.map((region) => ({ ...region })),
      })),
    };
  }
}
