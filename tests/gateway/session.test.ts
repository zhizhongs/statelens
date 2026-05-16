import { describe, expect, it } from 'vitest';
import {
  resolveActionLabel,
  resolveSessionId,
  stripStateLensHeaders,
} from '../../src/gateway/session.js';

describe('gateway session resolution', () => {
  it('prefers x-statelens-session-id header', () => {
    const headers = new Headers({ 'x-statelens-session-id': 'header-session' });
    const body = { metadata: { statelens_session_id: 'metadata-session' } };
    expect(resolveSessionId(headers, body, { STATELENS_SESSION_ID: 'env-session' })).toBe('header-session');
  });

  it('uses metadata session when the header is absent', () => {
    const body = { metadata: { statelens_session_id: 'metadata-session' } };
    expect(resolveSessionId(new Headers(), body, { STATELENS_SESSION_ID: 'env-session' })).toBe('metadata-session');
  });

  it('uses env session before default', () => {
    expect(resolveSessionId(new Headers(), {}, { STATELENS_SESSION_ID: 'env-session' })).toBe('env-session');
  });

  it('falls back to default session', () => {
    expect(resolveSessionId(new Headers(), {}, {})).toBe('default');
  });

  it('resolves action labels from header or metadata', () => {
    expect(resolveActionLabel(new Headers({ 'x-statelens-action-label': 'click' }), {})).toBe('click');
    expect(resolveActionLabel(new Headers(), { metadata: { statelens_action_label: 'type' } })).toBe('type');
  });

  it('strips StateLens-only headers before forwarding upstream', () => {
    const stripped = stripStateLensHeaders(
      new Headers({
        'x-statelens-session-id': 'session',
        'x-statelens-action-label': 'click',
        'x-api-key': 'key',
      })
    );
    expect(stripped.get('x-statelens-session-id')).toBeNull();
    expect(stripped.get('x-statelens-action-label')).toBeNull();
    expect(stripped.get('x-api-key')).toBe('key');
  });
});

