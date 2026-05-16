// Reference adapter that slots StateLens between a Playwright Page and the
// agent's reasoning model. See docs/POST_PHASE3_AGENT_INTEGRATION.md
// §"Reference Playwright Integration". We intentionally do not import from
// 'playwright' so the adapter has no runtime dependency on browser binaries;
// callers pass any object whose screenshot() returns a Buffer (real Playwright
// Page, fakes in tests, or other browser drivers with the same shape).

import type { Buffer } from 'node:buffer';
import { observe, type ObservationResult } from '../pipeline/index.js';
import { routeObservation, type ObservationRoute } from './routeObservation.js';

export interface PlaywrightLikePage {
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
}

export interface CaptureAndRouteResult {
  screenshot: Buffer;
  observation: ObservationResult;
  route: ObservationRoute;
}

export interface CaptureAndRouteOptions {
  sessionId?: string;
  actionLabel?: string;
  screenshotOptions?: Record<string, unknown>;
}

/**
 * Capture a screenshot from the page, run it through StateLens, and return an
 * actionable route for the agent loop.
 *
 * The contract:
 *   - route === 'skip_vision'           → do not send the screenshot anywhere
 *   - route === 'use_text_observation'  → use route.context as the model input
 *   - route === 'use_full_vision'       → send `screenshot` to your VLM
 *
 * The screenshot buffer is always returned so the caller can recover it for
 * the full-vision branch without re-capturing.
 */
export async function captureAndRoute(
  page: PlaywrightLikePage,
  options: CaptureAndRouteOptions = {}
): Promise<CaptureAndRouteResult> {
  const { sessionId = 'default', actionLabel, screenshotOptions } = options;
  // Force PNG by default — pixelmatch needs a deterministic encoding and JPEG
  // compression noise can mislead the visual gate's pixel diff. Callers can
  // override via screenshotOptions if they know what they want.
  const shotOpts = { type: 'png', ...(screenshotOptions ?? {}) };
  const screenshot = await page.screenshot(shotOpts);
  const observation = await observe(screenshot, sessionId, actionLabel);
  const route = routeObservation(observation);
  return { screenshot, observation, route };
}
