export {
  observe,
  getTimeline,
  resetSession,
  getVlmCumulativeUsage,
  resetVlmCumulativeUsage,
  prewarmPipeline,
  prewarmOcrWorker,
} from './pipeline/index.js';

export type {
  ChangedRegion,
  ObservationResult,
  TextDiff,
  TimelineEvent,
  TimelineResult,
  VlmUsage,
} from './pipeline/index.js';

export {
  DEFAULT_SCREENSHOT_INPUT_TOKEN_ESTIMATE,
  estimateRouteSavings,
  routeObservation,
} from './adapters/routeObservation.js';

export type {
  ObservationRoute,
  RouteSavingsEstimate,
} from './adapters/routeObservation.js';

export { captureAndRoute } from './adapters/playwright.js';

export type {
  CaptureAndRouteOptions,
  CaptureAndRouteResult,
  PlaywrightLikePage,
} from './adapters/playwright.js';

