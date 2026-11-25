/**
 * Where the user dragged boxes to, by node id. The graph is redrawn from a fresh snapshot every few seconds; without this a
 * redraw would put every box back at the position the layout computed and undo the drag. The rules, all pure:
 *  - a box the user moved keeps that position across snapshots (`placeNodes`);
 *  - a box that is new (never dragged) takes the layout's position;
 *  - a box that left the picture drops its saved position, so it starts from the layout if it ever comes back (`pruneSavedPositions`).
 */

export type XY = { x: number; y: number };
export type SavedPositions = Readonly<Record<string, XY>>;

export const NO_SAVED_POSITIONS: SavedPositions = Object.freeze({});

/** The nodes with the saved position put over the layout's one. A node without a saved position is returned untouched (same object). */
export function placeNodes<T extends { id: string; position: XY }>(nodes: T[], saved: SavedPositions): T[] {
  return nodes.map((node) => {
    const dragged = saved[node.id];
    return dragged ? { ...node, position: dragged } : node;
  });
}

/** `saved` without the ids that are no longer drawn. Returns `saved` itself when nothing had to go, so callers can compare by reference. */
export function pruneSavedPositions(saved: SavedPositions, liveIds: Iterable<string>): SavedPositions {
  const live = new Set(liveIds);
  const stale = Object.keys(saved).filter((id) => !live.has(id));
  if (stale.length === 0) return saved;
  const kept: Record<string, XY> = {};
  for (const id of Object.keys(saved)) if (live.has(id)) kept[id] = saved[id];
  return kept;
}

/**
 * `saved` with the position changes of one drag step recorded. Only `position` changes count (React Flow also reports
 * dimensions and selection, which the graph does not keep). Returns `saved` itself when nothing moved.
 */
export function recordPositions(saved: SavedPositions, changes: Iterable<{ id: string; type: string; position?: XY }>): SavedPositions {
  let next: Record<string, XY> | null = null;
  for (const change of changes) {
    if (change.type !== 'position' || !change.position) continue;
    const before = (next ?? saved)[change.id];
    if (before && before.x === change.position.x && before.y === change.position.y) continue;
    next ??= { ...saved };
    next[change.id] = { x: change.position.x, y: change.position.y };
  }
  return next ?? saved;
}
