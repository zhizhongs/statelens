import { describe, it, expect } from 'vitest';
import { shouldExpectVisualChange } from '../../src/pipeline/actionExpectation.js';

describe('shouldExpectVisualChange', () => {
  it('returns false for undefined, empty, or whitespace labels', () => {
    expect(shouldExpectVisualChange(undefined)).toBe(false);
    expect(shouldExpectVisualChange('')).toBe(false);
    expect(shouldExpectVisualChange('   ')).toBe(false);
  });

  it('returns true for explicit positive prefixes', () => {
    expect(shouldExpectVisualChange('expect_change:click_submit')).toBe(true);
    expect(shouldExpectVisualChange('expect-change:anything')).toBe(true);
    expect(shouldExpectVisualChange('mutating:custom_action')).toBe(true);
  });

  it('returns false for explicit passive prefixes even if the rest looks mutating', () => {
    expect(shouldExpectVisualChange('passive:click_submit')).toBe(false);
    expect(shouldExpectVisualChange('no_change_ok:checkout')).toBe(false);
    expect(shouldExpectVisualChange('observe:screenshot')).toBe(false);
  });

  it('returns false for passive labels', () => {
    for (const label of ['wait', 'sleep', 'poll', 'observe', 'screenshot', 'hover']) {
      expect(shouldExpectVisualChange(label)).toBe(false);
    }
  });

  it('returns true for high-confidence mutating substrings', () => {
    expect(shouldExpectVisualChange('click_submit')).toBe(true);
    expect(shouldExpectVisualChange('save_profile')).toBe(true);
    expect(shouldExpectVisualChange('login_user')).toBe(true);
    expect(shouldExpectVisualChange('sign_in_button')).toBe(true);
    expect(shouldExpectVisualChange('checkout')).toBe(true);
    expect(shouldExpectVisualChange('confirm_dialog')).toBe(true);
    expect(shouldExpectVisualChange('delete_item')).toBe(true);
    expect(shouldExpectVisualChange('upload_file')).toBe(true);
    expect(shouldExpectVisualChange('navigate_home')).toBe(true);
    expect(shouldExpectVisualChange('goto_page')).toBe(true);
    expect(shouldExpectVisualChange('reload')).toBe(true);
  });

  it('returns true for mutating verb prefixes', () => {
    expect(shouldExpectVisualChange('type_text')).toBe(true);
    expect(shouldExpectVisualChange('fill_form')).toBe(true);
    expect(shouldExpectVisualChange('select_option')).toBe(true);
    expect(shouldExpectVisualChange('press_enter')).toBe(true);
    expect(shouldExpectVisualChange('drag_node')).toBe(true);
    expect(shouldExpectVisualChange('drop_target')).toBe(true);
  });

  it('returns false for ambiguous click', () => {
    expect(shouldExpectVisualChange('click')).toBe(false);
    expect(shouldExpectVisualChange('click_menu')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(shouldExpectVisualChange('EXPECT_CHANGE:Foo')).toBe(true);
    expect(shouldExpectVisualChange('Click_Submit')).toBe(true);
    expect(shouldExpectVisualChange('WAIT')).toBe(false);
  });
});
