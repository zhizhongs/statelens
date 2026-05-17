// Shared per-session store — used by both observe() and observeWithEvidence()
// so the two orchestrators share session history and the LRU eviction policy.
// Kept private to the pipeline package; not part of the public library surface.

import { SessionTimeline } from './timeline.js';

const sessions = new Map<string, SessionTimeline>();

function configuredMaxSessions(): number {
  const parsed = Number.parseInt(process.env.STATELENS_MAX_SESSIONS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

export function getOrCreateSession(sessionId: string): SessionTimeline {
  const existing = sessions.get(sessionId);
  if (existing) {
    // Touch the session so the Map remains an LRU cache for long-running MCP use.
    sessions.delete(sessionId);
    sessions.set(sessionId, existing);
    return existing;
  }

  const session = new SessionTimeline(sessionId);
  sessions.set(sessionId, session);

  while (sessions.size > configuredMaxSessions()) {
    const oldest = sessions.keys().next().value;
    if (typeof oldest !== 'string') break;
    sessions.delete(oldest);
  }

  return session;
}

export function peekSession(sessionId: string): SessionTimeline | undefined {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}
