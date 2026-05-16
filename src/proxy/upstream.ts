const REQUEST_HEADER_BLOCKLIST = new Set([
  'host',
  'content-length',
  'connection',
  'x-statelens-session-id',
  'x-statelens-action-label',
]);

const RESPONSE_HEADER_BLOCKLIST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // fetch() automatically decodes the body; the original content-encoding and
  // content-length no longer describe what we're piping back to the SDK.
  'content-encoding',
  'content-length',
]);

export function sanitizeRequestHeaders(headers: Headers): Headers {
  const next = new Headers();
  headers.forEach((value, key) => {
    if (!REQUEST_HEADER_BLOCKLIST.has(key.toLowerCase())) {
      next.set(key, value);
    }
  });
  return next;
}

export function sanitizeResponseHeaders(headers: Headers): Headers {
  const next = new Headers();
  headers.forEach((value, key) => {
    if (!RESPONSE_HEADER_BLOCKLIST.has(key.toLowerCase())) {
      next.set(key, value);
    }
  });
  return next;
}

export async function forwardAnthropicRequest(args: {
  upstreamBaseUrl: string;
  path: string;
  method: string;
  headers: Headers;
  body: string;
}): Promise<Response> {
  const upstream = new URL(args.upstreamBaseUrl);
  const target = new URL(args.path, `${upstream.origin}${upstream.pathname.endsWith('/') ? upstream.pathname : `${upstream.pathname}/`}`);
  const headers = sanitizeRequestHeaders(args.headers);
  headers.set('content-type', 'application/json');

  return fetch(target, {
    method: args.method,
    headers,
    body: args.body,
  });
}

export type AnthropicForwarder = typeof forwardAnthropicRequest;
