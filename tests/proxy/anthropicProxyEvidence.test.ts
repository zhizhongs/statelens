import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { solidPng, pngWithRects } from '../pipeline/fixtures.js';
import type { AnthropicForwarder } from '../../src/proxy/upstream.js';
import type { ProxyOptions } from '../../src/gateway/types.js';

const tessMock = vi.hoisted(() => ({
  queue: [] as string[],
}));

vi.mock('tesseract.js', () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: tessMock.queue.shift() ?? '' } }),
    terminate: async () => {},
  }),
}));

import { processAnthropicMessagesRequest } from '../../src/proxy/anthropic.js';
import { resetSession } from '../../src/pipeline/index.js';

interface CapturedForward {
  path: string;
  body: string;
}

let captured: CapturedForward[] = [];

const options: ProxyOptions = {
  provider: 'anthropic',
  host: '127.0.0.1',
  port: 8443,
  upstreamBaseUrl: 'https://upstream.example',
  logLevel: 'silent',
};

const fakeForwarder: AnthropicForwarder = async (args) => {
  captured.push({ path: args.path, body: args.body });
  return Response.json({ ok: true }, { status: 200 });
};

function anthropicBody(imageBase64: string) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what changed?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
          },
        ],
      },
    ],
  };
}

async function sendRequest(body: unknown, headers = new Headers()): Promise<Response> {
  return processAnthropicMessagesRequest({
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    options,
    path: '/v1/messages',
    forwarder: fakeForwarder,
  });
}

describe('Anthropic proxy with STATELENS_REGION_EVIDENCE=1', () => {
  beforeEach(() => {
    captured = [];
    tessMock.queue.length = 0;
    process.env.STATELENS_REGION_EVIDENCE = '1';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    resetSession('proxy-evidence-test');
  });
  afterEach(() => {
    delete process.env.STATELENS_REGION_EVIDENCE;
  });

  it('forwards the first screenshot unchanged (session_start)', async () => {
    const screenshot = await solidPng(200, 100, '#ffffff');
    const body = anthropicBody(screenshot.toString('base64'));
    const headers = new Headers({ 'x-statelens-session-id': 'proxy-evidence-test' });
    await sendRequest(body, headers);
    expect(captured).toHaveLength(1);
    const sent = JSON.parse(captured[0].body);
    // session_start falls through to "forward_unchanged" with the original image.
    expect(sent.messages[0].content[1].type).toBe('image');
  });

  it('rewrites a localized text-bearing change into a text block + crop image blocks', async () => {
    const base = await solidPng(800, 600, '#ffffff');
    const changed = await pngWithRects(800, 600, '#ffffff', [
      { x: 150, y: 200, w: 200, h: 100, color: '#000000' },
    ]);
    // prev region empty, curr region has shipping_form keywords → high confidence.
    tessMock.queue.push('', 'Name Address Zip Code Chicago');

    const headers = new Headers({ 'x-statelens-session-id': 'proxy-evidence-test' });
    await sendRequest(anthropicBody(base.toString('base64')), headers);
    await sendRequest(anthropicBody(changed.toString('base64')), headers);

    expect(captured).toHaveLength(2);
    const sent = JSON.parse(captured[1].body);
    const content = sent.messages[0].content;
    const textBlocks = content.filter((b: any) => b.type === 'text');
    const imageBlocks = content.filter((b: any) => b.type === 'image');
    expect(textBlocks.length).toBeGreaterThanOrEqual(2);
    expect(imageBlocks.length).toBeGreaterThanOrEqual(1);

    const observationText = textBlocks
      .map((b: any) => b.text as string)
      .find((t: string) => t.includes('Event:'));
    expect(observationText).toBeDefined();
    expect(observationText).toContain('Confidence: ');
    expect(observationText).toContain('shipping_form');
    expect(observationText).toContain('crops are the changed regions only');

    // Crop image bytes must not be the original screenshot bytes.
    const originalB64 = changed.toString('base64');
    for (const block of imageBlocks) {
      expect(block.source.data).not.toBe(originalB64);
      expect(block.source.media_type).toBe('image/png');
    }
  });

  it('routes an identical second frame to skip_vision and emits no images', async () => {
    const frame = await solidPng(400, 300, '#ffffff');
    const headers = new Headers({ 'x-statelens-session-id': 'proxy-evidence-test' });
    await sendRequest(anthropicBody(frame.toString('base64')), headers);
    await sendRequest(anthropicBody(frame.toString('base64')), headers);

    expect(captured).toHaveLength(2);
    const sent = JSON.parse(captured[1].body);
    const content = sent.messages[0].content;
    const imageBlocks = content.filter((b: any) => b.type === 'image');
    expect(imageBlocks).toHaveLength(0);
    const text = content.find(
      (b: any) => b.type === 'text' && b.text.includes('No meaningful UI change')
    );
    expect(text).toBeDefined();
  });
});
