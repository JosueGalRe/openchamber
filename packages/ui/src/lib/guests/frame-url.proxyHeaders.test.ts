import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import { setRuntimeExtraHeaders } from '@/lib/runtime-auth';
import { resolveGuestFrameUrl } from './frame-url';

describe('guest frame source in the native app', () => {
  let window: Window;
  let requests: { url: string; proxyHeader: string | null }[];
  let restoreFetch = () => {};
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    window = new Window({ url: 'http://localhost/' });
    Object.defineProperty(window, 'Capacitor', { configurable: true, value: { isNativePlatform: () => true } });
    for (const [key, value] of Object.entries({ window, document: window.document, DOMParser: window.DOMParser })) {
      previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    requests = [];
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, proxyHeader: new Headers(options?.headers).get('cf-access-client-id') });
      if (url.includes('/frame-grant')) return Response.json({ grant: 'grant-1', expiresAt: Date.now() + 60_000 });
      return new Response('<!doctype html><html><head></head><body>panel</body></html>', { headers: { 'content-type': 'text/html' } });
    });
    restoreFetch = () => fetch.mockRestore();
  });

  afterEach(async () => {
    setRuntimeExtraHeaders(null);
    restoreFetch();
    await window.happyDOM.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    previousGlobals.clear();
  });

  test('a connection with proxy headers loads the package over runtime HTTP, never as a navigable URL', async () => {
    setRuntimeExtraHeaders({ 'CF-Access-Client-Id': 'demo' });
    const frame = await resolveGuestFrameUrl('dev-tools', 'panel/index.html');
    expect(frame.kind).toBe('document');
    expect(requests.some((request) => request.url.includes('/frame-grant'))).toBe(false);
    expect(requests.every((request) => request.proxyHeader === 'demo')).toBe(true);
  });

  test('a connection without proxy headers keeps the grant URL', async () => {
    const frame = await resolveGuestFrameUrl('dev-tools', 'panel/index.html');
    expect(frame.kind).toBe('url');
    expect(frame.kind === 'url' ? frame.url : '').toContain('/api/guest-files/grant-1/panel/index.html');
  });
});
