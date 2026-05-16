import { beforeEach, describe, expect, it } from 'vitest';
import {
  parseProxyOptions,
  processAnthropicMessagesRequest,
} from '../../src/proxy/anthropic.js';
import type { ProxyOptions } from '../../src/gateway/types.js';
import { resetSession } from '../../src/pipeline/index.js';
import { solidPng } from '../pipeline/fixtures.js';
import type { AnthropicForwarder } from '../../src/proxy/upstream.js';

interface CapturedForward {
  path: string;
  headers: Headers;
  body: string;
}

let captured: CapturedForward[] = [];
let upstreamStatus = 200;

const options: ProxyOptions = {
  provider: 'anthropic',
  host: '127.0.0.1',
  port: 8443,
  upstreamBaseUrl: 'https://upstream.example',
  logLevel: 'silent',
};

const fakeForwarder: AnthropicForwarder = async (args) => {
  captured.push({
    path: args.path,
    headers: args.headers,
    body: args.body,
  });
  return Response.json(
    { ok: upstreamStatus < 400, content: [{ type: 'text', text: 'upstream' }] },
    { status: upstreamStatus }
  );
};

function anthropicBody(imageBase64?: string) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: imageBase64
          ? [
              { type: 'text', text: 'what changed?' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
              },
            ]
          : [{ type: 'text', text: 'hello' }],
      },
    ],
  };
}

async function process(body: unknown, headers = new Headers()): Promise<Response> {
  return processAnthropicMessagesRequest({
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    options,
    path: '/v1/messages',
    forwarder: fakeForwarder,
  });
}

describe('Anthropic proxy request processing', () => {
  beforeEach(() => {
    captured = [];
    upstreamStatus = 200;
    resetSession('proxy-test');
  });

  it('parses CLI options', () => {
    expect(
      parseProxyOptions(
        ['--provider', 'anthropic', '--host', '0.0.0.0', '--port', '9999', '--upstream', 'https://example.com'],
        {}
      )
    ).toMatchObject({
      provider: 'anthropic',
      host: '0.0.0.0',
      port: 9999,
      upstreamBaseUrl: 'https://example.com',
    });
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await process('{nope');
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it('passes no-image messages through unchanged', async () => {
    const body = anthropicBody();
    const res = await process(body, new Headers({ 'x-api-key': 'test-key' }));

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0].body)).toEqual(body);
    expect(captured[0].headers.get('x-api-key')).toBe('test-key');
  });

  it('forwards the first screenshot unchanged and rewrites an identical second screenshot', async () => {
    const screenshot = await solidPng(120, 80, '#ffffff');
    const body = anthropicBody(screenshot.toString('base64'));
    const headers = new Headers({
      'x-api-key': 'test-key',
      'x-statelens-session-id': 'proxy-test',
    });

    await process(body, headers);
    await process(body, headers);

    expect(captured).toHaveLength(2);
    const first = JSON.parse(captured[0].body);
    const second = JSON.parse(captured[1].body);
    expect(first.messages[0].content[1].type).toBe('image');
    expect(second.messages[0].content[1].type).toBe('text');
    expect(second.messages[0].content[1].text).toContain('No meaningful UI change');
    expect(captured[1].headers.get('x-statelens-session-id')).toBeNull();
  });

  it('passes upstream errors through', async () => {
    upstreamStatus = 401;
    const res = await process(anthropicBody());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });
});

