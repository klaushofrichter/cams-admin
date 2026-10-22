// The proxy-originated camera-move events (contract/v1 event.schema.json, the
// move.* kinds: no cmdId). Validated strictly before they reach a handler.

export type MoveKind = 'stills' | 'clips' | 'events' | 'checks' | 'archive';
export type MovePlanSpace = 'all' | 'omit' | 'fit' | 'retention';
export type MoveRole = 'source' | 'target';
export type MoveEventPhase = 'opened' | 'switching' | 'switched' | 'released' | 'copying' | 'copied' | 'finished' | 'cancelled' | 'failed';

interface Head { proxyId: string; connId: string }
export interface MovePlan {
  transfer?: boolean; kinds?: MoveKind[]; space?: MovePlanSpace; targetSettings?: Record<string, boolean | number | string> | null; budgetS?: number; estimateS?: number;
}
export interface MoveCameraConn {
  proxyCameraId: string; name: string; host: string; protocol: 'https' | 'http'; user: string; onvifPort: number; rtspPort: number; baichuanPort: number;
}
export type MoveKindSummary = Record<MoveKind, { files: number; bytes: number; rows: number; oldest: number | null; newest: number | null }>;

export interface MoveTargetsEvent extends Head { kind: 'move.targets'; requestId: string; camera: string }
export interface MoveRequestEvent extends Head {
  kind: 'move.request'; requestId: string; camera: MoveCameraConn; target: string; actor: { origin: string; label: string }; summary: MoveKindSummary; settings: Record<string, unknown>;
}
export interface MoveApproveEvent extends Head { kind: 'move.approve'; moveId: string; plan: MovePlan }
export interface MoveCancelEvent extends Head { kind: 'move.cancel'; moveId: string; copied: 'delete' | 'age-out' }
export interface MovePhaseEvent extends Head { kind: 'move.phase'; moveId: string; role: MoveRole; phase: MoveEventPhase; ok: boolean; code?: string; detail?: string }
export interface MoveProgressEvent extends Head {
  kind: 'move.progress'; moveId: string; chunks: { id: string; state: 'pending' | 'copied' | 'verified' | 'skipped' | 'failed' }[]; bytesDone: number; bytesTotal: number; rateBps: number; etaS: number;
}

export type MoveEvent = MoveTargetsEvent | MoveRequestEvent | MoveApproveEvent | MoveCancelEvent | MovePhaseEvent | MoveProgressEvent;
