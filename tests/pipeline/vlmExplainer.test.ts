import { describe, it, expect, beforeEach, vi } from 'vitest';

const anthropicMock = vi.hoisted(() => ({
  responseQueue: [] as Array<unknown>,
  createCalls: { value: 0 },
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: async () => {
        anthropicMock.createCalls.value++;
        const next = anthropicMock.responseQueue.shift();
        if (next instanceof Error) throw next;
        if (!next) {
          throw new Error('MockAnthropic: no queued response');
        }
        return next;
      },
    };
  }
  return { default: MockAnthropic };
});

import {
  vlmExplain,
  getCumulativeUsage,
  resetCumulativeUsage,
} from '../../src/pipeline/vlmExplainer.js';
import { solidPng } from './fixtures.js';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  anthropicMock.responseQueue.length = 0;
  anthropicMock.createCalls.value = 0;
  resetCumulativeUsage();
});

function textResponse(text: string, usage = { input_tokens: 100, output_tokens: 20 }) {
  return {
    content: [{ type: 'text', text }],
    usage,
  };
}

describe('vlmExplain', () => {
  it('parses snake_case JSON into camelCase VlmExplanation', async () => {
    anthropicMock.responseQueue.push(
      textResponse(
        JSON.stringify({
          event_type: 'error_appeared',
          summary: 'A login error appeared',
          important_text: ['Invalid password'],
        })
      )
    );
    const prev = await solidPng(20, 20, '#ffffff');
    const curr = await solidPng(20, 20, '#000000');
    const result = await vlmExplain(prev, curr, []);
    expect(result.eventType).toBe('error_appeared');
    expect(result.summary).toBe('A login error appeared');
    expect(result.importantText).toEqual(['Invalid password']);
  });

  it('strips ```json fences before parsing', async () => {
    const fenced = '```json\n{"event_type":"modal_opened","summary":"Modal opened","important_text":[]}\n```';
    anthropicMock.responseQueue.push(textResponse(fenced));
    const prev = await solidPng(20, 20, '#ffffff');
    const curr = await solidPng(20, 20, '#000000');
    const result = await vlmExplain(prev, curr, []);
    expect(result.eventType).toBe('modal_opened');
    expect(result.summary).toBe('Modal opened');
  });

  it('increments cumulative usage after a successful call', async () => {
    anthropicMock.responseQueue.push(
      textResponse(
        JSON.stringify({ event_type: 'x', summary: 'y', important_text: [] }),
        { input_tokens: 1234, output_tokens: 56 }
      )
    );
    const prev = await solidPng(20, 20, '#ffffff');
    const curr = await solidPng(20, 20, '#000000');
    await vlmExplain(prev, curr, []);
    expect(getCumulativeUsage()).toEqual({ input_tokens: 1234, output_tokens: 56 });
  });

  it('resetCumulativeUsage() clears both counters', async () => {
    anthropicMock.responseQueue.push(
      textResponse(
        JSON.stringify({ event_type: 'x', summary: 'y', important_text: [] }),
        { input_tokens: 100, output_tokens: 10 }
      )
    );
    const prev = await solidPng(20, 20, '#ffffff');
    const curr = await solidPng(20, 20, '#000000');
    await vlmExplain(prev, curr, []);
    resetCumulativeUsage();
    expect(getCumulativeUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('still counts usage when JSON parsing fails', async () => {
    anthropicMock.responseQueue.push(
      textResponse('not even close to JSON', { input_tokens: 500, output_tokens: 5 })
    );
    const prev = await solidPng(20, 20, '#ffffff');
    const curr = await solidPng(20, 20, '#000000');
    await expect(vlmExplain(prev, curr, [])).rejects.toThrow();
    expect(getCumulativeUsage()).toEqual({ input_tokens: 500, output_tokens: 5 });
  });

  it('throws a clear error when the response has no text block', async () => {
    anthropicMock.responseQueue.push({
      content: [{ type: 'tool_use', name: 'noop', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const prev = await solidPng(20, 20, '#ffffff');
    const curr = await solidPng(20, 20, '#000000');
    await expect(vlmExplain(prev, curr, [])).rejects.toThrow(/no text block/);
  });
});
