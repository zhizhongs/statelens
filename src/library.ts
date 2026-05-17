export {
  observe,
  getTimeline,
  resetSession,
  getVlmCumulativeUsage,
  resetVlmCumulativeUsage,
  prewarmPipeline,
  prewarmOcrWorker,
  bboxFromRegion,
} from './pipeline/index.js';

export type {
  ChangedRegion,
  ObservationResult,
  TextDiff,
  TimelineEvent,
  TimelineResult,
  VlmUsage,
  ObservationConfidence,
  EvidenceRegion,
  EvidenceRegionSource,
  VisualEvidence,
  EvidenceObservation,
} from './pipeline/index.js';

export {
  observeWithEvidence,
} from './pipeline/observeEvidence.js';

export type {
  ObserveEvidenceOptions,
} from './pipeline/observeEvidence.js';

export {
  regionLabeler,
  confidenceForRegion,
  aggregateConfidence,
  SEMANTIC_LABELS,
} from './pipeline/regionLabeler.js';

export {
  buildVisualEvidence,
  DEFAULT_CROP_OPTIONS,
} from './pipeline/evidenceCropper.js';

export type {
  CropOptions,
} from './pipeline/evidenceCropper.js';

export {
  DEFAULT_SCREENSHOT_INPUT_TOKEN_ESTIMATE,
  REGION_EVIDENCE_MAX_AREA_FRACTION,
  REGION_EVIDENCE_MAX_CROPS,
  estimateRouteSavings,
  routeEvidenceObservation,
  routeObservation,
} from './adapters/routeObservation.js';

export type {
  ObservationRoute,
  RouteEvidenceOptions,
  RouteSavingsEstimate,
} from './adapters/routeObservation.js';

export { captureAndRoute } from './adapters/playwright.js';

export type {
  CaptureAndRouteOptions,
  CaptureAndRouteResult,
  PlaywrightLikePage,
} from './adapters/playwright.js';

