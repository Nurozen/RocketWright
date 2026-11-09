/**
 * Runs before every web test file. jsdom's `document.hasFocus()` is always
 * false, which would read every blur in a test as the window losing focus; a
 * test window has focus unless a test says otherwise (`windowFocus.ts`).
 */
if (typeof document !== "undefined") document.hasFocus = () => true;
