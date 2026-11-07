import type { SurfaceInputEvent, SurfaceModifiers } from '@openchamber/sdk';

const NO_MODIFIERS: SurfaceModifiers = { alt: false, ctrl: false, meta: false, shift: false };

const keyPress = (key: 'Backspace' | 'Enter', keyCode: number): SurfaceInputEvent[] => [
  { type: 'key', action: 'down', key, code: key, keyCode, modifiers: NO_MODIFIERS },
  { type: 'key', action: 'up', key, code: key, keyCode, modifiers: NO_MODIFIERS },
];

/**
 * What a phone keyboard changed in the surface's hidden text field, as surface
 * input. Characters the keyboard took back go out as Backspace, the text after
 * the common prefix as typed text, and a line break as Enter (inserted "\n"
 * does nothing in a single-line field). The keyboard rewrites the word it is
 * composing in place (suggestions, accents, autocorrect), so comparing whole
 * values follows it without reading composition events.
 * shortcut: assumes edits at the end of the field, which holds while the field is hidden and short; a caret moved by keyboard gestures would need selection tracking.
 */
export const surfaceKeyboardEdits = (previous: string, next: string): SurfaceInputEvent[] => {
  // Code points, so an emoji is one Backspace like it is one character on screen.
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common += 1;

  const events: SurfaceInputEvent[] = [];
  for (let index = common; index < before.length; index += 1) events.push(...keyPress('Backspace', 8));
  after.slice(common).join('').split('\n').forEach((text, line) => {
    if (line > 0) events.push(...keyPress('Enter', 13));
    if (text) events.push({ type: 'text', text });
  });
  return events;
};
