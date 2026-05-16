import { describe, expect, it } from 'vitest';
import {
  captureAndRoute,
  estimateRouteSavings,
  observe,
  routeObservation,
} from '../src/library.js';

describe('public library exports', () => {
  it('exposes the pipeline, routing helper, and in-process adapter from one entrypoint', () => {
    expect(typeof observe).toBe('function');
    expect(typeof routeObservation).toBe('function');
    expect(typeof estimateRouteSavings).toBe('function');
    expect(typeof captureAndRoute).toBe('function');
  });
});

