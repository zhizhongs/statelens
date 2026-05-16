import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  extractLatestAnthropicImageBlock,
  replaceAnthropicImageBlockWithText,
} from '../../src/gateway/anthropicImageBlocks.js';

const IMG_A = Buffer.from('image-a').toString('base64');
const IMG_B = Buffer.from('image-b').toString('base64');

function requestBody() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG_A } },
          { type: 'text', text: 'earlier prompt' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'latest prompt' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG_B } },
        ],
      },
    ],
  };
}

describe('Anthropic image block helpers', () => {
  it('extracts the last image from the final user message', () => {
    const image = extractLatestAnthropicImageBlock(requestBody());

    expect(image).toMatchObject({
      messageIndex: 2,
      contentIndex: 1,
      mediaType: 'image/png',
      data: IMG_B,
    });
    expect(image?.bytes.toString()).toBe('image-b');
  });

  it('ignores unsupported media types', () => {
    const body = requestBody();
    const latest = body.messages[2].content[1] as Record<string, any>;
    latest.source.media_type = 'image/gif';

    expect(extractLatestAnthropicImageBlock(body)).toBeNull();
  });

  it('ignores invalid base64', () => {
    const body = requestBody();
    const latest = body.messages[2].content[1] as Record<string, any>;
    latest.source.data = 'not valid base64!?';

    expect(extractLatestAnthropicImageBlock(body)).toBeNull();
  });

  it('replaces the selected image with a text block without mutating the original body', () => {
    const body = requestBody();
    const image = extractLatestAnthropicImageBlock(body);
    expect(image).not.toBeNull();

    const rewritten = replaceAnthropicImageBlockWithText(body, image!, 'StateLens says no change') as any;

    expect(rewritten.messages[2].content[1]).toEqual({
      type: 'text',
      text: 'StateLens says no change',
    });
    expect(rewritten.messages[0].content[0].source.data).toBe(IMG_A);
    expect((body.messages[2].content[1] as any).type).toBe('image');
  });
});

