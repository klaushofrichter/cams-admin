import type { Clock } from '../clock';
import type { Db } from '../db/open';
import type { Audit } from '../audit';
import { BearerTokens, hashOf, type BearerView } from '../auth/bearer-tokens';

// Read-only diagnostics tokens (issue #45). It opens the GET routes under
// /api/v1/diag and nothing else. The store itself is the shared BearerTokens.

export const DIAG_PREFIX = 'cad_';
export const MAX_LIVE = 5;
export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 365;

export type DiagTokenView = BearerView;
export { hashOf };

export class DiagTokens extends BearerTokens<DiagTokenView> {
  constructor(d: { db: Db; clock: Clock; audit: Audit; journal?: (tokenId: string) => void }) {
    super(d, { table: 'diag_tokens', prefix: DIAG_PREFIX, idPrefix: 'dgt', auditPrefix: 'diag-token', defaultDays: DEFAULT_DAYS, maxDays: MAX_DAYS, maxLive: MAX_LIVE });
  }
}
