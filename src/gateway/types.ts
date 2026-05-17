import type { Buffer } from 'node:buffer';
import type {
  EvidenceObservation,
  ObservationResult,
} from '../pipeline/index.js';
import type { ObservationRoute } from '../adapters/routeObservation.js';

export type Provider = 'anthropic';

export interface ProxyOptions {
  provider: Provider;
  host: string;
  port: number;
  upstreamBaseUrl: string;
  logLevel: 'silent' | 'info' | 'debug';
}

export interface GatewayContext {
  provider: Provider;
  sessionId: string;
  actionLabel?: string;
  requestId: string;
}

export interface ExtractedImageBlock {
  messageIndex: number;
  contentIndex: number;
  mediaType: 'image/png' | 'image/jpeg';
  data: string;
  bytes: Buffer;
}

export type GatewayAction = 'forward_unchanged' | 'forward_rewritten';

export interface GatewayRewriteResult {
  action: GatewayAction;
  reason: string;
  requestBody: unknown;
  observation?: ObservationResult | EvidenceObservation;
  route?: ObservationRoute;
}

