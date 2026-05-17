// Internal helpers shared between observe() and observeWithEvidence(). Hidden
// from the public library surface — this module exists purely to keep
// observe()'s timeline contract consistent across both orchestrators.

import type { SessionTimeline } from './timeline.js';
import { getOrCreateSession } from './sessionStore.js';
import type { ChangedRegion, TextDiff } from './index.js';

interface EvidenceKeyframeFields {
  eventType: string;
  eventSummary: string;
  regions: ChangedRegion[];
  textDiff: TextDiff;
  vlmCalled: boolean;
}

function recordEvidenceKeyframe(
  session: SessionTimeline,
  fields: EvidenceKeyframeFields
): void {
  session.addEvent({
    step: session.totalScreenshots,
    event_type: fields.eventType,
    summary: fields.eventSummary,
    text_diff: {
      added: [...fields.textDiff.added],
      removed: [...fields.textDiff.removed],
    },
    regions: fields.regions.map((region) => ({ ...region })),
    vlm_used: fields.vlmCalled,
  });
}

export const _internal = {
  getOrCreateSession,
  recordEvidenceKeyframe,
};
