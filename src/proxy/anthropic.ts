import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { observe, getTimeline, resetSession } from '../pipeline/index.js';
import { observeWithEvidence } from '../pipeline/observeEvidence.js';
import {
  routeEvidenceObservation,
  routeObservation,
} from '../adapters/routeObservation.js';
import {
  extractLatestAnthropicImageBlock,
} from '../gateway/anthropicImageBlocks.js';
import { rewriteAnthropicRequestForRoute } from '../gateway/requestRouting.js';
import { buildGatewayContext } from '../gateway/session.js';
import type { GatewayRewriteResult, ProxyOptions } from '../gateway/types.js';
import {
  type AnthropicForwarder,
  forwardAnthropicRequest,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
} from './upstream.js';

function regionEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STATELENS_REGION_EVIDENCE === '1';
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8443;
const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function headersFromIncoming(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  return headers;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeUpstreamResponse(res: ServerResponse, upstream: Response): void {
  const headers = sanitizeResponseHeaders(upstream.headers);
  headers.forEach((value, key) => res.setHeader(key, value));
  res.statusCode = upstream.status;

  if (!upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body as unknown as ReadableStream<Uint8Array>).pipe(res);
}

function parseIntOption(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

export function parseProxyOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ProxyOptions {
  const provider = readFlag(argv, '--provider') ?? 'anthropic';
  if (provider !== 'anthropic') {
    throw new Error(`Unsupported proxy provider "${provider}". MVP supports "anthropic".`);
  }

  const host =
    readFlag(argv, '--host') ??
    env.STATELENS_PROXY_HOST ??
    DEFAULT_HOST;
  const port = parseIntOption(
    readFlag(argv, '--port') ?? env.STATELENS_PROXY_PORT,
    DEFAULT_PORT
  );
  const upstreamBaseUrl =
    readFlag(argv, '--upstream') ??
    env.STATELENS_ANTHROPIC_UPSTREAM_BASE_URL ??
    DEFAULT_UPSTREAM;
  const logLevel = (env.STATELENS_LOG_LEVEL ?? 'info') as ProxyOptions['logLevel'];

  return {
    provider: 'anthropic',
    host,
    port,
    upstreamBaseUrl,
    logLevel: ['silent', 'info', 'debug'].includes(logLevel) ? logLevel : 'info',
  };
}

function proxyLog(
  options: ProxyOptions,
  level: 'info' | 'debug',
  payload: Record<string, unknown>
): void {
  if (options.logLevel === 'silent') return;
  if (level === 'debug' && options.logLevel !== 'debug') return;
  console.error(JSON.stringify(payload));
}

async function forwardJson(
  options: ProxyOptions,
  path: string,
  headers: Headers,
  body: unknown,
  forwarder: AnthropicForwarder = forwardAnthropicRequest
): Promise<Response> {
  return forwarder({
    upstreamBaseUrl: options.upstreamBaseUrl,
    path,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function forwardRaw(
  options: ProxyOptions,
  path: string,
  headers: Headers,
  rawBody: string,
  forwarder: AnthropicForwarder = forwardAnthropicRequest
): Promise<Response> {
  return forwarder({
    upstreamBaseUrl: options.upstreamBaseUrl,
    path,
    method: 'POST',
    headers,
    body: rawBody,
  });
}

export async function processAnthropicMessagesRequest(args: {
  rawBody: string;
  headers: Headers;
  options: ProxyOptions,
  path: string;
  forwarder?: AnthropicForwarder;
}): Promise<Response> {
  const { rawBody, headers, options, path, forwarder = forwardAnthropicRequest } = args;
  let body: unknown;

  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Request body is not valid JSON' }, { status: 400 });
  }

  const image = extractLatestAnthropicImageBlock(body);
  if (!image) {
    return forwardRaw(options, path, sanitizeRequestHeaders(headers), rawBody, forwarder);
  }

  const context = buildGatewayContext({
    provider: 'anthropic',
    headers,
    body,
  });

  let rewrite: GatewayRewriteResult | null = null;
  const started = Date.now();
  const useEvidence = regionEvidenceEnabled();
  try {
    if (useEvidence) {
      const observation = await observeWithEvidence(image.bytes, {
        sessionId: context.sessionId,
        actionLabel: context.actionLabel,
        includeCrops: true,
      });
      const route = routeEvidenceObservation(observation);
      rewrite = rewriteAnthropicRequestForRoute({ requestBody: body, image, route });
    } else {
      const observation = await observe(image.bytes, context.sessionId, context.actionLabel);
      const route = routeObservation(observation);
      rewrite = rewriteAnthropicRequestForRoute({ requestBody: body, image, route });
    }
  } catch (err) {
    proxyLog(options, 'info', {
      request_id: context.requestId,
      provider: 'anthropic',
      session_id: context.sessionId,
      route: 'forward_unchanged',
      reason: err instanceof Error ? err.message : String(err),
      rewritten: false,
      latency_ms: Date.now() - started,
    });
    return forwardRaw(options, path, sanitizeRequestHeaders(headers), rawBody, forwarder);
  }

  // Crop bytes are sensitive — log shape but never the base64 payload unless
  // STATELENS_LOG_IMAGES=1 is explicitly set.
  const cropCount =
    rewrite.route &&
    (rewrite.route.route === 'use_region_evidence' ||
      rewrite.route.route === 'use_context_snapshot')
      ? rewrite.route.evidence.length
      : 0;

  // Diagnostic counters from the underlying observation: how many regions the
  // pipeline produced and how many had usable crops attached. Helpful when
  // route=use_full_vision so we can tell the difference between "cropper
  // dropped everything" vs "labels weren't anchored".
  const observation = rewrite.observation;
  const regionsCount = observation?.changed_regions?.length ?? 0;
  const evidenceCount =
    observation && 'visual_evidence' in observation
      ? observation.visual_evidence.length
      : 0;
  const aggregateConfidence =
    observation && 'visual_evidence' in observation
      ? observation.confidence
      : undefined;

  proxyLog(options, 'info', {
    request_id: context.requestId,
    provider: 'anthropic',
    session_id: context.sessionId,
    route: rewrite.route?.route ?? 'forward_unchanged',
    reason: rewrite.reason,
    event_type: rewrite.observation?.event_type,
    vlm_called: rewrite.observation?.vlm_called,
    rewritten: rewrite.action === 'forward_rewritten',
    crop_count: cropCount,
    regions_count: regionsCount,
    evidence_count: evidenceCount,
    aggregate_confidence: aggregateConfidence,
    region_evidence_enabled: useEvidence,
    latency_ms: Date.now() - started,
  });

  if (rewrite.action === 'forward_rewritten') {
    return forwardJson(options, path, sanitizeRequestHeaders(headers), rewrite.requestBody, forwarder);
  }
  return forwardRaw(options, path, sanitizeRequestHeaders(headers), rawBody, forwarder);
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
  path: string
): Promise<void> {
  const rawBody = await readRequestBody(req);
  const upstream = await processAnthropicMessagesRequest({
    rawBody,
    headers: headersFromIncoming(req),
    options,
    path,
  });
  writeUpstreamResponse(res, upstream);
}

function sessionIdFromPath(pathname: string, suffix: string): string | null {
  if (!pathname.startsWith('/sessions/') || !pathname.endsWith(suffix)) return null;
  const raw = pathname.slice('/sessions/'.length, pathname.length - suffix.length);
  return raw ? decodeURIComponent(raw) : null;
}

export function createAnthropicProxyServer(options: ProxyOptions) {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${options.host}:${options.port}`}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        jsonResponse(res, 200, { ok: true, name: 'statelens-proxy', provider: 'anthropic' });
        return;
      }

      const timelineSession = sessionIdFromPath(url.pathname, '/timeline');
      if (req.method === 'GET' && timelineSession) {
        jsonResponse(res, 200, getTimeline(timelineSession));
        return;
      }

      const resetSessionId = sessionIdFromPath(url.pathname, '/reset');
      if (req.method === 'POST' && resetSessionId) {
        resetSession(resetSessionId);
        jsonResponse(res, 200, { ok: true, session_id: resetSessionId });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        await handleMessages(req, res, options, `${url.pathname}${url.search}`);
        return;
      }

      jsonResponse(res, 404, { error: 'Not found' });
    })().catch((err) => {
      jsonResponse(res, 502, {
        error: 'StateLens proxy request failed',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseProxyOptions(argv);
  process.env.STATELENS_PROXY_ACTIVE = '1';
  process.env.STATELENS_ANTHROPIC_UPSTREAM_BASE_URL = options.upstreamBaseUrl;

  const server = createAnthropicProxyServer(options);
  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, resolve);
  });

  console.error(`StateLens proxy listening on http://${options.host}:${options.port}`);
  console.error(`Provider: ${options.provider}`);
  console.error(`Upstream: ${options.upstreamBaseUrl}`);
  console.error(
    `Mode: ${regionEvidenceEnabled() ? 'fail-open text rewrite + region evidence' : 'fail-open text rewrite'}`
  );
}
