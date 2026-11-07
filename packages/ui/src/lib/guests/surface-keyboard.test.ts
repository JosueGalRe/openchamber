import { describe, expect, test } from 'bun:test';
import type { SurfaceInputEvent } from '@openchamber/sdk';

import { surfaceKeyboardEdits } from './surface-keyboard';

/** The events as a short script: text in quotes, keys by name. */
const script = (events: SurfaceInputEvent[]): string[] => events.flatMap((event) => {
  if (event.type === 'text') return [JSON.stringify(event.text)];
  if (event.type === 'key' && event.action === 'down') return [event.key];
  return [];
});

describe('phone keyboard edits on a shared surface', () => {
  test('typing sends only the new characters', () => {
    expect(script(surfaceKeyboardEdits('', 'h'))).toEqual(['"h"']);
    expect(script(surfaceKeyboardEdits('h', 'ho'))).toEqual(['"o"']);
  });

  test('every key press comes with its release', () => {
    const events = surfaceKeyboardEdits('ab', 'a');
    expect(events.map((event) => (event.type === 'key' ? `${event.key}:${event.action}` : event.type))).toEqual(['Backspace:down', 'Backspace:up']);
  });

  test('a composed word that the keyboard corrects is deleted back to the change and retyped', () => {
    expect(script(surfaceKeyboardEdits('hila', 'hola'))).toEqual(['Backspace', 'Backspace', 'Backspace', '"ola"']);
  });

  test('an accent composed over a letter replaces that letter', () => {
    expect(script(surfaceKeyboardEdits('cafe', 'café'))).toEqual(['Backspace', '"é"']);
  });

  test('deleting removes one character per Backspace', () => {
    expect(script(surfaceKeyboardEdits('hola', 'ho'))).toEqual(['Backspace', 'Backspace']);
  });

  test('an emoji is one character to delete', () => {
    expect(script(surfaceKeyboardEdits('a😀', 'a'))).toEqual(['Backspace']);
  });

  test('a line break goes out as Enter between the text around it', () => {
    expect(script(surfaceKeyboardEdits('ab', 'ab\ncd'))).toEqual(['Enter', '"cd"']);
    expect(script(surfaceKeyboardEdits('', '\n'))).toEqual(['Enter']);
  });

  test('no change sends nothing', () => {
    expect(surfaceKeyboardEdits('same', 'same')).toEqual([]);
  });
});
