/**
 * Sub-agents are drawn one zoom step smaller than the office (never under 1),
 * so they stay pixel-crisp (the sprite cache is per zoom) and read at a glance
 * as helpers beside their lead. Everything that measures a character on
 * screen (drawing, hit-testing, the outline, the icon over it) scales by the
 * same factor, anchored at its feet. Pure, so it runs on the Node test runner.
 */

/** The zoom a character is drawn at. */
export function characterZoom(isSubagent: boolean, zoom: number): number {
  return isSubagent ? Math.max(1, zoom - 1) : zoom;
}

/** A character's size relative to the office's (1 for an agent). */
export function characterScale(isSubagent: boolean, zoom: number): number {
  return characterZoom(isSubagent, zoom) / zoom;
}
