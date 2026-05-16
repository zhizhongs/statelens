import { describe, it, expect, beforeEach, vi } from 'vitest';
import { solidPng } from './fixtures.js';

const ocrMock = vi.hoisted(() => {
  return {
    queue: [] as string[],
    recognizeCalls: { value: 0 },
    workerCreateCalls: { value: 0 },
  };
});

vi.mock('tesseract.js', () => ({
  createWorker: async () => {
    ocrMock.workerCreateCalls.value++;
    return {
      recognize: async () => {
        ocrMock.recognizeCalls.value++;
        return { data: { text: ocrMock.queue.shift() ?? '' } };
      },
      terminate: async () => {},
    };
  },
}));

import { ocrDiff, resetOcrWorker } from '../../src/pipeline/ocrDiff.js';

describe('ocrDiff', () => {
  beforeEach(async () => {
    ocrMock.queue.length = 0;
    ocrMock.recognizeCalls.value = 0;
    ocrMock.workerCreateCalls.value = 0;
    await resetOcrWorker();
  });

  it('returns empty diff and skips worker init when regions is empty', async () => {
    const img = await solidPng(200, 100, '#ffffff');
    const result = await ocrDiff(img, img, []);
    expect(result).toEqual({ added: [], removed: [] });
    expect(ocrMock.workerCreateCalls.value).toBe(0);
    expect(ocrMock.recognizeCalls.value).toBe(0);
  });

  it('reports a new line in added when OCR text appears', async () => {
    const prev = await solidPng(200, 100, '#ffffff');
    const curr = await solidPng(200, 100, '#ffffff');
    // Order: prev crop, curr crop.
    ocrMock.queue.push('', 'Welcome back');
    const result = await ocrDiff(prev, curr, [
      { x: 10, y: 10, w: 100, h: 30, label: 'content area' },
    ]);
    expect(result.added).toContain('Welcome back');
    expect(result.removed).toEqual([]);
  });

  it('reports a disappeared line in removed', async () => {
    const prev = await solidPng(200, 100, '#ffffff');
    const curr = await solidPng(200, 100, '#ffffff');
    ocrMock.queue.push('Error: bad password', '');
    const result = await ocrDiff(prev, curr, [
      { x: 10, y: 10, w: 100, h: 30, label: 'content area' },
    ]);
    expect(result.removed).toContain('Error: bad password');
    expect(result.added).toEqual([]);
  });

  it('returns empty diff when text is unchanged', async () => {
    const prev = await solidPng(200, 100, '#ffffff');
    const curr = await solidPng(200, 100, '#ffffff');
    ocrMock.queue.push('Username', 'Username');
    const result = await ocrDiff(prev, curr, [
      { x: 10, y: 10, w: 100, h: 30, label: 'content area' },
    ]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });
});
