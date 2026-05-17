import { describe, it, expect, beforeEach, vi } from 'vitest';
import { solidPng } from './fixtures.js';

const ocrMock = vi.hoisted(() => {
  return {
    queue: [] as string[],
    recognizeCalls: { value: 0 },
    workerCreateCalls: { value: 0 },
    workerCreateLangs: [] as unknown[],
  };
});

vi.mock('tesseract.js', () => ({
  createWorker: async (langs?: unknown) => {
    ocrMock.workerCreateCalls.value++;
    ocrMock.workerCreateLangs.push(langs);
    return {
      recognize: async () => {
        ocrMock.recognizeCalls.value++;
        return { data: { text: ocrMock.queue.shift() ?? '' } };
      },
      terminate: async () => {},
    };
  },
}));

import { ocrDiff, prewarmOcrWorker, resetOcrWorker } from '../../src/pipeline/ocrDiff.js';

describe('ocrDiff', () => {
  beforeEach(async () => {
    ocrMock.queue.length = 0;
    ocrMock.recognizeCalls.value = 0;
    ocrMock.workerCreateCalls.value = 0;
    ocrMock.workerCreateLangs.length = 0;
    delete process.env.STATELENS_OCR_LANGS;
    // Force single-worker pool for tests that assert on worker-create counts.
    // Production default is 4; tests opting into multi-worker behavior set this
    // explicitly inside the test body.
    process.env.STATELENS_OCR_POOL_SIZE = '1';
    await resetOcrWorker();
  });

  it('returns empty diff and skips worker init when regions is empty', async () => {
    const img = await solidPng(200, 100, '#ffffff');
    const result = await ocrDiff(img, img, []);
    expect(result).toEqual({ added: [], removed: [] });
    expect(ocrMock.workerCreateCalls.value).toBe(0);
    expect(ocrMock.recognizeCalls.value).toBe(0);
  });

  it('prewarmOcrWorker initializes the worker before the first OCR diff', async () => {
    await prewarmOcrWorker();
    expect(ocrMock.workerCreateCalls.value).toBe(1);
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

  it('resizes the previous screenshot before cropping mismatched dimensions', async () => {
    const prev = await solidPng(200, 100, '#ffffff');
    const curr = await solidPng(400, 200, '#ffffff');
    ocrMock.queue.push('', 'Welcome back');
    const result = await ocrDiff(prev, curr, [
      { x: 300, y: 20, w: 80, h: 40, label: 'right panel' },
    ]);
    expect(result.added).toContain('Welcome back');
    expect(ocrMock.recognizeCalls.value).toBe(2);
  });

  it('normalizes unicode OCR lines without stripping non-ASCII text', async () => {
    const prev = await solidPng(200, 100, '#ffffff');
    const curr = await solidPng(200, 100, '#ffffff');
    ocrMock.queue.push('Cafe\u0301\u0000 menu', 'Café menu\n送信\t完了');
    const result = await ocrDiff(prev, curr, [
      { x: 10, y: 10, w: 100, h: 30, label: 'content area' },
    ]);
    expect(result.added).toContain('送信 完了');
    expect(result.added).not.toContain('Café menu');
    expect(result.removed).toEqual([]);
  });

  describe('language configuration (STATELENS_OCR_LANGS)', () => {
    it('defaults to eng when STATELENS_OCR_LANGS is unset', async () => {
      await prewarmOcrWorker();
      expect(ocrMock.workerCreateCalls.value).toBe(1);
      expect(ocrMock.workerCreateLangs[0]).toBe('eng');
    });

    it('passes STATELENS_OCR_LANGS through to createWorker', async () => {
      process.env.STATELENS_OCR_LANGS = 'eng+spa';
      await prewarmOcrWorker();
      expect(ocrMock.workerCreateCalls.value).toBe(1);
      expect(ocrMock.workerCreateLangs[0]).toBe('eng+spa');
    });

    it('resetOcrWorker lets tests switch language configuration', async () => {
      await prewarmOcrWorker();
      expect(ocrMock.workerCreateLangs[0]).toBe('eng');

      await resetOcrWorker();
      process.env.STATELENS_OCR_LANGS = 'eng+jpn';
      await prewarmOcrWorker();
      expect(ocrMock.workerCreateCalls.value).toBe(2);
      expect(ocrMock.workerCreateLangs[1]).toBe('eng+jpn');
    });

    it('empty-region calls do not initialize Tesseract', async () => {
      process.env.STATELENS_OCR_LANGS = 'eng+spa';
      const img = await solidPng(200, 100, '#ffffff');
      const result = await ocrDiff(img, img, []);
      expect(result).toEqual({ added: [], removed: [] });
      expect(ocrMock.workerCreateCalls.value).toBe(0);
    });

    it('blank STATELENS_OCR_LANGS falls back to eng', async () => {
      process.env.STATELENS_OCR_LANGS = '   ';
      await prewarmOcrWorker();
      expect(ocrMock.workerCreateLangs[0]).toBe('eng');
    });
  });

  describe('worker pool (STATELENS_OCR_POOL_SIZE)', () => {
    it('creates N workers when STATELENS_OCR_POOL_SIZE=N', async () => {
      process.env.STATELENS_OCR_POOL_SIZE = '4';
      await resetOcrWorker();
      await prewarmOcrWorker();
      expect(ocrMock.workerCreateCalls.value).toBe(4);
      // All workers get the same language config.
      for (const lang of ocrMock.workerCreateLangs) {
        expect(lang).toBe('eng');
      }
    });

    it('caps pool size at 8 to avoid runaway worker creation', async () => {
      process.env.STATELENS_OCR_POOL_SIZE = '100';
      await resetOcrWorker();
      await prewarmOcrWorker();
      expect(ocrMock.workerCreateCalls.value).toBe(8);
    });
  });
});
