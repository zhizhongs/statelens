import { randomUUID } from 'node:crypto';
import type { GatewayContext, Provider } from './types.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringFromMetadata(body: unknown, key: string): string | undefined {
  if (!isRecord(body) || !isRecord(body.metadata)) return undefined;
  const value = body.metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringFromEnv(
  env: NodeJS.ProcessEnv,
  key: string
): string | undefined {
  const value = env[key];
  return value && value.trim() ? value.trim() : undefined;
}

export function resolveSessionId(
  headers: Headers,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env
): string {
  return (
    headers.get('x-statelens-session-id')?.trim() ||
    stringFromMetadata(body, 'statelens_session_id') ||
    stringFromEnv(env, 'STATELENS_SESSION_ID') ||
    'default'
  );
}

export function resolveActionLabel(
  headers: Headers,
  body: unknown
): string | undefined {
  return (
    headers.get('x-statelens-action-label')?.trim() ||
    stringFromMetadata(body, 'statelens_action_label')
  );
}

export function stripStateLensHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete('x-statelens-session-id');
  next.delete('x-statelens-action-label');
  return next;
}

export function buildGatewayContext(args: {
  provider: Provider;
  headers: Headers;
  body: unknown;
  env?: NodeJS.ProcessEnv;
}): GatewayContext {
  return {
    provider: args.provider,
    sessionId: resolveSessionId(args.headers, args.body, args.env),
    actionLabel: resolveActionLabel(args.headers, args.body),
    requestId: `sl_${randomUUID()}`,
  };
}

