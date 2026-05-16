// Phase 4 — failure detection classifier.
// See docs/PIPELINE_PHASE4_IMPLEMENTATION.md "Action Label Classifier".

const POSITIVE_PREFIXES = ['expect_change:', 'expect-change:', 'mutating:'];
const PASSIVE_PREFIXES = ['passive:', 'no_change_ok:', 'observe:'];

const PASSIVE_LABELS = new Set([
  'wait',
  'sleep',
  'poll',
  'observe',
  'screenshot',
  'hover',
]);

const MUTATING_SUBSTRINGS = [
  'submit',
  'save',
  'login',
  'sign_in',
  'checkout',
  'confirm',
  'delete',
  'upload',
  'navigate',
  'goto',
  'reload',
];

const MUTATING_VERB_PREFIXES = [
  'type_',
  'fill_',
  'select_',
  'press_',
  'drag_',
  'drop_',
];

export function shouldExpectVisualChange(actionLabel?: string): boolean {
  if (typeof actionLabel !== 'string') return false;
  const trimmed = actionLabel.trim();
  if (trimmed.length === 0) return false;

  const lower = trimmed.toLowerCase();

  for (const prefix of POSITIVE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  for (const prefix of PASSIVE_PREFIXES) {
    if (lower.startsWith(prefix)) return false;
  }

  if (PASSIVE_LABELS.has(lower)) return false;

  for (const sub of MUTATING_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  for (const prefix of MUTATING_VERB_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  return false;
}
