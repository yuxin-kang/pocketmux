const INTERACTIVE_DRAWER_SELECTOR = 'button, input, select, textarea, a[href], [role="button"]';

export function shouldBeginDrawerSwipe(target) {
  return !target?.closest?.(INTERACTIVE_DRAWER_SELECTOR);
}
