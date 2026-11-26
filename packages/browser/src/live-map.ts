/**
 * Where a box of the page shows on the live view's stage. The view draws its effects in a canvas
 * over the picture of the tab, so a box the agent cursor measured in the page's viewport (CSS
 * pixels, at the scroll the page had then) must land on the same element in the picture shown
 * now: scaled from the page's size to the size the picture is displayed at, moved by how far
 * the page scrolled since, and times the canvas's device pixel ratio.
 *
 * These functions are sent to the view as source (`live-page.ts`), so each one stays
 * self-contained: no imports, no calls to the others.
 */

/** The geometry of one screencast frame, from its metadata. */
export interface FrameGeometry {
  /** The page's viewport, in device-independent pixels (`deviceWidth`, `deviceHeight`). */
  w: number;
  h: number;
  /** The page's scroll when the frame was taken, in CSS pixels (`scrollOffsetX`, `scrollOffsetY`). */
  sx: number;
  sy: number;
  /** The pinch zoom (`pageScaleFactor`); 1 on a desktop page. */
  scale: number;
  /** Space above the page in the frame, in device-independent pixels (`offsetTop`). */
  top: number;
}

/** A rectangle on the stage, in its CSS pixels. */
export interface StageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A page box (or a point, with no width and height) on the stage. `scroll` is the page's scroll
 * when the box was measured; without it the box is taken to be in the frame's own viewport.
 * `view` is where the picture is displayed on the stage. Null when either has no size yet.
 */
export function pageToStage(
  box: { x: number; y: number; width?: number; height?: number },
  scroll: { x: number; y: number } | null | undefined,
  frame: FrameGeometry,
  view: StageRect,
): StageRect | null {
  if (!(frame.w > 0) || !(frame.h > 0) || !(view.w > 0) || !(view.h > 0)) return null;
  const k = view.w / frame.w;
  const s = frame.scale > 0 ? frame.scale : 1;
  const dx = scroll ? scroll.x - frame.sx : 0;
  const dy = scroll ? scroll.y - frame.sy : 0;
  return {
    x: view.x + (box.x + dx) * s * k,
    y: view.y + ((frame.top || 0) + (box.y + dy) * s) * k,
    w: (box.width ?? 0) * s * k,
    h: (box.height ?? 0) * s * k,
  };
}

/**
 * A stage rectangle in the canvas's pixels, as WebGL reads them: times the device pixel ratio
 * (capped at 2, which is all a 7 px cell needs) and from the bottom edge up. `height` is the
 * canvas's height in its own pixels. Returns `[x, y, w, h]`.
 */
export function stageToCanvas(r: StageRect, dpr: number, height: number): [number, number, number, number] {
  const d = Math.min(2, dpr > 0 ? dpr : 1);
  return [r.x * d, height - (r.y + r.h) * d, r.w * d, r.h * d];
}
