import { tx, type Db } from '../../server/db/open';
import { ApiError } from '../../server/registry';
import type { MoveStore } from '../../server/moves/store';

// Names the move on its camera (cameras.move_id), as Registry.moveCamera does at the switch-over, but without
// stamping moves.switched_at. 404 for an unknown move.
export function markCamera(db: Db, store: MoveStore, moveId: string): void {
  tx(db, () => {
    const m = store.get(moveId);
    if (!m) throw new ApiError(404, 'not_found');
    db.prepare('UPDATE cameras SET move_id = ? WHERE id = ?').run(moveId, m.cameraId);
  });
}
