import React from 'react';

import type { SurfaceInputEvent, SurfaceModifiers } from '@openchamber/sdk';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import { surfaceKeyboardEdits } from '@/lib/guests/surface-keyboard';
import { clearSurfaceViewerId, setSurfaceViewerId } from '@/lib/guests/surface-viewers';
import { SurfaceClient, type SurfaceConnectionState, type SurfaceControlState, type SurfaceFrame } from '@/lib/guests/surface-client';
import { pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { releaseSoftKeyboardFocus } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * The rail panel of an extension whose service shows a shared surface: a
 * live picture of what the agent is working in, which the user can take
 * over by clicking or typing and hand back with one button.
 *
 * The picture is a canvas the host draws; the extension never runs code in
 * this panel. Pointer and keyboard events are translated to frame pixels
 * and sent as a batch per animation frame. While the surface has focus the
 * host's own shortcuts stand down (`data-terminal-owner`, the same gate the
 * terminal uses), so a Ctrl+P typed into a remote page stays in that page.
 * Paste sends text rather than the key chord; copy sends the chord and then
 * asks the extension for what was copied, so the user's clipboard follows.
 */

type Props = { mode: PluginContextPanelMode };

const RESIZE_DEBOUNCE_MS = 250;
/** CSS pixels a finger travels before a touch counts as a scroll instead of a tap. */
const TOUCH_SCROLL_SLOP_PX = 8;
/** Characters the hidden keyboard field keeps before it starts over between words. */
const KEYBOARD_FIELD_MAX = 64;
/** Keys a phone or attached keyboard sends that edit or move rather than type a character. */
const KEYBOARD_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SurfaceModifiers => ({
  alt: event.altKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
  shift: event.shiftKey,
});

const isCopyChord = (event: React.KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'c';
const isPasteChord = (event: React.KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'v';

export const GuestSurfacePane: React.FC<Props> = ({ mode }) => {
  const { t } = useI18n();
  const guestId = pluginIdFromMode(mode);
  const guest = useGuestsStore((state) => state.guests.find((entry) => entry.id === guestId) ?? null);
  const active = guest !== null && isGuestActive(guest) && guest.service?.surface === true;
  // New package files stop the service, which ends the session; a new client attaches to the next one.
  const packageKey = `${guest?.version ?? ''}:${guest?.revision ?? 0}`;

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const clientRef = React.useRef<SurfaceClient | null>(null);
  const frameSizeRef = React.useRef<{ width: number; height: number } | null>(null);
  const batchRef = React.useRef<SurfaceInputEvent[]>([]);
  const flushRef = React.useRef<number | null>(null);
  const clipboardRequestsRef = React.useRef(0);
  /** A copy chord in the current batch: ask for the clipboard right after it. */
  const clipboardAfterFlushRef = React.useRef(false);
  const controlRef = React.useRef<SurfaceControlState>({ controller: 'none', mine: false });
  const touchRef = React.useRef<{
    id: number;
    /** Frame pixels where the finger landed: the tap's click and every wheel of the gesture. */
    point: { x: number; y: number };
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    scrolling: boolean;
    cancelled: boolean;
  } | null>(null);

  const [connection, setConnection] = React.useState<SurfaceConnectionState>({ status: 'connecting' });
  const [control, setControlState] = React.useState<SurfaceControlState>({ controller: 'none', mine: false });
  const setControl = React.useCallback((next: SurfaceControlState) => {
    controlRef.current = next;
    setControlState(next);
  }, []);
  const [title, setTitle] = React.useState<string>('');
  const [agentActive, setAgentActive] = React.useState(false);
  const [hasFrame, setHasFrame] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  // A phone opens its keyboard only for a focused text field, and the picture
  // is not one: a hidden field takes the typing and the host forwards it.
  const touchDevice = React.useMemo(() => window.matchMedia?.('(pointer: coarse)').matches === true, []);
  const keyboardRef = React.useRef<HTMLTextAreaElement | null>(null);
  /** What the hidden field held at the last input, to compare the next one with. */
  const keyboardValueRef = React.useRef('');
  const [keyboardOpen, setKeyboardOpen] = React.useState(false);

  // The field goes away with the picture (pane closed, extension paused): it
  // lets go of the keyboard first and the next field starts from nothing.
  React.useLayoutEffect(() => {
    const field = keyboardRef.current;
    return () => {
      keyboardValueRef.current = '';
      setKeyboardOpen(false);
      if (field && document.activeElement === field) releaseSoftKeyboardFocus(field);
    };
  }, [active]);

  // Android's back gesture and the keyboard's own hide key close the keyboard
  // without blurring the field; the native shell announces it.
  // shortcut: a phone browser outside the app sends no such event, so there the button needs a second tap; visualViewport could tell.
  React.useEffect(() => {
    const onIntent = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.open !== false) return;
      if (keyboardRef.current && document.activeElement === keyboardRef.current) keyboardRef.current.blur();
    };
    window.addEventListener('oc:keyboard-intent', onIntent);
    return () => window.removeEventListener('oc:keyboard-intent', onIntent);
  }, []);

  // Nothing typed reaches the page while the socket is down, so the keyboard goes.
  React.useEffect(() => {
    if (connection.status !== 'open' && keyboardRef.current && document.activeElement === keyboardRef.current) keyboardRef.current.blur();
  }, [connection.status]);

  const drawFrame = React.useCallback(async (frame: SurfaceFrame) => {
    const canvas = canvasRef.current;
    const client = clientRef.current;
    if (!canvas || !client) return;
    try {
      const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: frame.mime }));
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      const context = canvas.getContext('2d');
      context?.drawImage(bitmap, 0, 0, frame.width, frame.height);
      bitmap.close();
      frameSizeRef.current = { width: frame.width, height: frame.height };
      setHasFrame(true);
      setTitle(frame.title ?? '');
      setAgentActive(frame.agentActive);
    } catch {
      // An undecodable frame is skipped; the next one replaces it.
    } finally {
      // Acknowledged after drawing, whatever happened: an unacknowledged
      // frame would stop every later one.
      client.ack(frame.seq);
    }
  }, []);

  React.useEffect(() => {
    if (!active) return undefined;
    let viewerId: string | null = null;
    const client = new SurfaceClient(guestId, {
      onViewer: (id) => {
        if (viewerId) clearSurfaceViewerId(guestId, viewerId);
        viewerId = id;
        setSurfaceViewerId(guestId, id);
      },
      onFrame: (frame) => { void drawFrame(frame); },
      onControl: setControl,
      onConnection: setConnection,
      onClipboard: (_id, text) => { void copyTextToClipboard(text); },
      // Input the service refused never reached the page, so the keyboard
      // field no longer matches it; it starts over instead of drifting further.
      onError: (code) => {
        if (code !== 'INPUT_STALE' || !keyboardRef.current) return;
        keyboardRef.current.value = '';
        keyboardValueRef.current = '';
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      if (viewerId) clearSurfaceViewerId(guestId, viewerId);
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
      if (flushRef.current !== null) cancelAnimationFrame(flushRef.current);
      flushRef.current = null;
      batchRef.current = [];
      frameSizeRef.current = null;
      touchRef.current = null;
      setHasFrame(false);
    };
  }, [active, drawFrame, guestId, packageKey, setControl]);

  // Tell the extension how much room the panel has, so a browser or a
  // simulator can lay itself out at that size instead of being scaled.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const scale = window.devicePixelRatio || 1;
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);
        if (w > 0 && h > 0) clientRef.current?.resize(w, h);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  const queue = React.useCallback((event: SurfaceInputEvent) => {
    batchRef.current.push(event);
    if (flushRef.current !== null) return;
    flushRef.current = requestAnimationFrame(() => {
      flushRef.current = null;
      const events = batchRef.current;
      batchRef.current = [];
      clientRef.current?.sendInput(events);
      // Sent on the same socket right after the batch; the host handles
      // them in order, so the extension has done the copy by the time it
      // is asked what was copied.
      if (clipboardAfterFlushRef.current) {
        clipboardAfterFlushRef.current = false;
        clipboardRequestsRef.current += 1;
        clientRef.current?.requestClipboard(`copy-${clipboardRequestsRef.current}`);
      }
    });
  }, []);

  /** Pointer position in frame pixels, or null when outside the picture. */
  const framePoint = React.useCallback((event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const size = frameSizeRef.current;
    if (!canvas || !size) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * size.width;
    const y = ((event.clientY - rect.top) / rect.height) * size.height;
    return { x: Math.round(x), y: Math.round(y) };
  }, []);

  /**
   * A finger has no hover and its drag is how a page scrolls on a phone: a
   * tap goes out as a click where it landed, a drag past the slop as wheel
   * deltas at that same point, so the scroll stays with what was touched.
   * Nothing is sent on touch-down, so a scroll never presses a link, and a
   * second finger cancels the gesture rather than clicking or scrolling.
   */
  const onTouch = (action: 'down' | 'up' | 'move' | 'cancel', event: React.PointerEvent<HTMLCanvasElement>) => {
    const touch = touchRef.current;
    if (action === 'down') {
      if (touch) {
        touch.cancelled = true;
        return;
      }
      const point = framePoint(event);
      if (!point) return;
      // With the phone keyboard up, focus stays in its field, so tapping the next field on the page keeps typing.
      if (keyboardRef.current && document.activeElement === keyboardRef.current) event.preventDefault();
      else containerRef.current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      touchRef.current = { id: event.pointerId, point, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, scrolling: false, cancelled: false };
      return;
    }
    if (!touch || touch.id !== event.pointerId) return;
    event.preventDefault();
    if (action === 'move') {
      if (touch.cancelled) return;
      if (!touch.scrolling && Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) < TOUCH_SCROLL_SLOP_PX) return;
      touch.scrolling = true;
      queue({ type: 'wheel', x: touch.point.x, y: touch.point.y, deltaX: touch.lastX - event.clientX, deltaY: touch.lastY - event.clientY, modifiers: modifiersOf(event) });
      touch.lastX = event.clientX;
      touch.lastY = event.clientY;
      return;
    }
    touchRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (action !== 'up' || touch.scrolling || touch.cancelled) return;
    const modifiers = modifiersOf(event);
    queue({ type: 'pointer', action: 'down', x: touch.point.x, y: touch.point.y, button: 0, buttons: 1, modifiers });
    queue({ type: 'pointer', action: 'up', x: touch.point.x, y: touch.point.y, button: 0, buttons: 0, modifiers });
  };

  const onPointer = (action: 'down' | 'up' | 'move') => (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    if (event.pointerType === 'touch') {
      onTouch(action, event);
      return;
    }
    // Hovering is looking, not acting: moves without a button go out only
    // once the user holds control, so a glance never takes it from the agent.
    if (action === 'move' && event.buttons === 0 && !(controlRef.current.controller === 'user' && controlRef.current.mine)) return;
    const point = framePoint(event);
    if (!point) return;
    if (action === 'down') {
      containerRef.current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (action === 'up' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    queue({
      type: 'pointer',
      action,
      x: point.x,
      y: point.y,
      button: action === 'move' ? -1 : event.button,
      buttons: event.buttons,
      modifiers: modifiersOf(event),
    });
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    const point = framePoint(event);
    if (!point) return;
    event.preventDefault();
    queue({ type: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) });
  };

  const onKey = (action: 'down' | 'up') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasFrame) return;
    if (isPasteChord(event)) {
      // The paste event carries the text; the chord itself stays here.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action === 'down' && isCopyChord(event)) clipboardAfterFlushRef.current = true;
    queue({ type: 'key', action, key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiersOf(event) });
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!hasFrame) return;
    const text = event.clipboardData.getData('text/plain');
    event.preventDefault();
    if (text) queue({ type: 'text', text });
  };

  const release = () => {
    clientRef.current?.release();
  };

  const clearKeyboardField = () => {
    if (keyboardRef.current) keyboardRef.current.value = '';
    keyboardValueRef.current = '';
  };

  // Focus happens inside the button's own tap: phone browsers open the keyboard only then.
  const toggleKeyboard = () => {
    const field = keyboardRef.current;
    if (!field) return;
    if (document.activeElement === field) field.blur();
    else field.focus();
  };

  const onKeyboardInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    for (const edit of surfaceKeyboardEdits(keyboardValueRef.current, field.value)) queue(edit);
    keyboardValueRef.current = field.value;
    // The keyboard owns the field while it composes a word; between words the field can start over.
    const composing = event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing;
    if (!composing && field.value.length > KEYBOARD_FIELD_MAX) clearKeyboardField();
  };

  const onKeyboardKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The surface around the field would send the key a second time.
    event.stopPropagation();
    if (!hasFrame || event.nativeEvent.isComposing || event.keyCode === 229 || isPasteChord(event)) return;
    const chord = event.ctrlKey || event.metaKey || event.altKey;
    // Characters arrive as input; Backspace in an empty field changes nothing there, so it goes to the page as a key.
    const emptyBackspace = event.key === 'Backspace' && event.currentTarget.value === '';
    if (!chord && !emptyBackspace && !KEYBOARD_KEYS.has(event.key)) return;
    event.preventDefault();
    if (isCopyChord(event)) clipboardAfterFlushRef.current = true;
    const modifiers = modifiersOf(event);
    queue({ type: 'key', action: 'down', key: event.key, code: event.code, keyCode: event.keyCode, modifiers });
    queue({ type: 'key', action: 'up', key: event.key, code: event.code, keyCode: event.keyCode, modifiers });
  };

  if (!guest) return null;
  if (!active) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        {t('contextPanel.surface.unavailable')}
      </div>
    );
  }

  const statusKey = (() => {
    if (connection.status === 'connecting') return 'contextPanel.surface.status.connecting';
    if (connection.status === 'reconnecting') return 'contextPanel.surface.status.reconnecting';
    if (connection.status === 'ended') return `contextPanel.surface.ended.${connection.reason}` as const;
    if (control.controller === 'user') return control.mine ? 'contextPanel.surface.status.youControl' : 'contextPanel.surface.status.otherControls';
    if (control.controller === 'agent' || agentActive) return 'contextPanel.surface.status.agentWorking';
    return focused ? 'contextPanel.surface.status.readyFocused' : 'contextPanel.surface.status.ready';
  })();

  return (
    <div className="flex h-full flex-col bg-[var(--surface-background)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="typography-meta min-w-0 flex-1 truncate text-foreground" title={title || guest.name}>
          {title || guest.name}
        </span>
        <span
          className={cn(
            'typography-meta shrink-0 truncate',
            control.controller === 'user' && control.mine ? 'text-foreground' : 'text-muted-foreground',
          )}
          aria-live="polite"
        >
          {t(statusKey)}
        </span>
        {touchDevice && hasFrame && connection.status === 'open' ? (
          <Button
            size="xs"
            variant="chip"
            className="w-6 shrink-0 px-0"
            aria-pressed={keyboardOpen}
            aria-label={t(keyboardOpen ? 'contextPanel.surface.keyboard.hide' : 'contextPanel.surface.keyboard.show')}
            title={t(keyboardOpen ? 'contextPanel.surface.keyboard.hide' : 'contextPanel.surface.keyboard.show')}
            // Focus stays in the hidden field, so the next tap closes the keyboard instead of reopening it.
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleKeyboard}
          >
            <Icon name="keyboard" className="size-3.5" />
          </Button>
        ) : null}
        {control.controller === 'user' && control.mine ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="xs" variant="outline" onClick={release}>
                {t('contextPanel.surface.handBack')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.panel.releaseSurface')}</TooltipContent>
          </Tooltip>
        ) : null}
        {connection.status === 'ended' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="xs" variant="outline" onClick={() => clientRef.current?.retry()}>
                {t('contextPanel.surface.retry')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.panel.reconnectSurface')}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label={t('contextPanel.surface.canvasAria', { name: guest.name })}
        data-terminal-owner={`surface:${guestId}`}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden outline-none',
          focused ? 'ring-1 ring-inset ring-[var(--interactive-selection-border)]' : '',
        )}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKey('down')}
        onKeyUp={onKey('up')}
        onPaste={onPaste}
      >
        <canvas
          ref={canvasRef}
          className={cn('max-h-full max-w-full touch-none', hasFrame ? 'block' : 'hidden', control.controller === 'user' && !control.mine ? 'cursor-not-allowed' : 'cursor-default')}
          onPointerDown={onPointer('down')}
          onPointerMove={onPointer('move')}
          onPointerUp={onPointer('up')}
          onPointerCancel={(event) => { if (event.pointerType === 'touch') onTouch('cancel', event); }}
          onWheel={onWheel}
          onContextMenu={(event) => event.preventDefault()}
        />
        {touchDevice ? (
          <textarea
            ref={keyboardRef}
            aria-label={t('contextPanel.surface.canvasAria', { name: guest.name })}
            tabIndex={-1}
            rows={1}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            // 16px keeps iOS from zooming the page when the field takes focus.
            className="pointer-events-none absolute bottom-0 start-0 size-px resize-none overflow-hidden border-0 bg-transparent p-0 text-base text-transparent opacity-0 outline-none"
            onFocus={() => setKeyboardOpen(true)}
            onBlur={() => {
              setKeyboardOpen(false);
              clearKeyboardField();
            }}
            onInput={onKeyboardInput}
            onKeyDown={onKeyboardKey}
            onKeyUp={(event) => event.stopPropagation()}
          />
        ) : null}
        {!hasFrame || connection.status !== 'open' ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t(connection.status === 'ended' ? `contextPanel.surface.ended.${connection.reason}` : connection.status === 'reconnecting' ? 'contextPanel.surface.status.reconnecting' : 'contextPanel.surface.status.connecting')}
          </div>
        ) : null}
      </div>
    </div>
  );
};
