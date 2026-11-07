import React from 'react';
import { GUEST_SURFACE_DOCK_SIZE_MIN } from '@openchamber/sdk';

import type { GuestSurfaceDocking } from '@/lib/guests/surfaces';
import type { PluginContextPanelMode } from '@/lib/surfaces/modes';
import { cn } from '@/lib/utils';

const PluginPane = React.lazy(() => import('./PluginPane').then((module) => ({ default: module.PluginPane })));
const GuestSurfacePane = React.lazy(() => import('./GuestSurfacePane').then((module) => ({ default: module.GuestSurfacePane })));

// How an extension page sits beside its shared surface: flex direction puts
// the page first on top/left and last on bottom/right; the page's size is
// fixed across the docked edge and the picture takes the rest.
const DOCK_LAYOUT = {
  top: { container: 'flex-col', page: 'border-b border-border', vertical: true },
  bottom: { container: 'flex-col-reverse', page: 'border-t border-border', vertical: true },
  left: { container: 'flex-row', page: 'border-e border-border', vertical: false },
  right: { container: 'flex-row-reverse', page: 'border-s border-border', vertical: false },
} as const;

/**
 * A shared-surface extension's own page, docked to one edge of the picture.
 * It starts at the manifest's `panel.size` and follows the page's
 * `host.setHeight` after that (the thickness across its edge, so a width
 * for a left or right dock), never below the manifest minimum and never past
 * half the panel, so the picture always stays in view.
 */
const DockedGuestPage: React.FC<{ mode: PluginContextPanelMode; docking: GuestSurfaceDocking; onSessionStarted?: () => void }> = ({ mode, docking, onSessionStarted }) => {
  const [requested, setRequested] = React.useState<number | null>(null);
  const layout = DOCK_LAYOUT[docking.dock];
  const size = Math.max(GUEST_SURFACE_DOCK_SIZE_MIN, requested ?? docking.size);
  return (
    <div
      className={cn(
        'shrink-0 overflow-hidden duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        layout.vertical ? 'max-h-[50%] transition-[height]' : 'max-w-[50%] transition-[width]',
        layout.page,
      )}
      style={layout.vertical ? { height: size } : { width: size }}
    >
      <PluginPane mode={mode} onResize={setRequested} onSessionStarted={onSessionStarted} />
    </div>
  );
};

/**
 * A shared-surface extension: the host-drawn picture, with the extension's
 * own page docked to one edge when it has one. The picture mounts only while
 * `surfaceMounted`, so an unwatched surface holds no socket and its service
 * can idle out; the docked page stays mounted like any panel iframe.
 */
export const GuestSharedSurface: React.FC<{
  mode: PluginContextPanelMode;
  docking: GuestSurfaceDocking | null;
  surfaceMounted: boolean;
  /** Where the panel covers the chat (the phone's drawer), a session the page opens has to come into view. */
  onSessionStarted?: () => void;
}> = ({ mode, docking, surfaceMounted, onSessionStarted }) => (
  <React.Suspense fallback={null}>
    {!docking ? (
      surfaceMounted ? <GuestSurfacePane mode={mode} /> : null
    ) : (
      <div className={cn('flex h-full', DOCK_LAYOUT[docking.dock].container)}>
        <DockedGuestPage mode={mode} docking={docking} onSessionStarted={onSessionStarted} />
        <div className="min-h-0 min-w-0 flex-1">
          {surfaceMounted ? <GuestSurfacePane mode={mode} /> : null}
        </div>
      </div>
    )}
  </React.Suspense>
);
