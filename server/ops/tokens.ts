import { BearerTokens, type BearerDeps, type BearerView, type Row } from '../auth/bearer-tokens';
import { FieldError } from '../validate';

// Operations tokens: write-scoped bearer tokens for scripts, so a revoke, a
// route change or a move cancel needs no Google sign-in. Each token carries
// the scopes it may use; the route to scope table lives with the router.

export const OPS_SCOPES = ['tokens', 'routes', 'moves', 'registry', 'onboard', 'actions', 'config', 'offboard'] as const;
export type OpsScope = (typeof OPS_SCOPES)[number];
export const OPS_PREFIX = 'cao_';
export const OPS_MAX_LIVE = 5;
export const OPS_DEFAULT_DAYS = 30;
export const OPS_MAX_DAYS = 90;

export interface OpsTokenView extends BearerView { scopes: OpsScope[] }

export class OpsTokens extends BearerTokens<OpsTokenView> {
  constructor(d: BearerDeps) {
    super(d, { table: 'ops_tokens', prefix: OPS_PREFIX, idPrefix: 'opt', auditPrefix: 'ops-token', defaultDays: OPS_DEFAULT_DAYS, maxDays: OPS_MAX_DAYS, maxLive: OPS_MAX_LIVE });
  }

  protected parseExtra(o: Record<string, unknown>) {
    const s = o.scopes;
    if (!Array.isArray(s) || s.length === 0 || new Set(s).size !== s.length || !s.every((x) => (OPS_SCOPES as readonly unknown[]).includes(x))) throw new FieldError('scopes');
    return { cols: { scopes: JSON.stringify(s) }, detail: { scopes: s } };
  }

  // A corrupt column fails closed: no scopes.
  private scopesOf(r: Row): OpsScope[] {
    try {
      const s: unknown = JSON.parse(r.scopes as string);
      return Array.isArray(s) && s.every((x) => (OPS_SCOPES as readonly unknown[]).includes(x)) ? (s as OpsScope[]) : [];
    } catch { return []; }
  }

  protected viewExtra(r: Row) { return { scopes: this.scopesOf(r) }; }

  verifyScoped(token: string): { id: string; hashPrefix: string; scopes: OpsScope[] } | null {
    const r = this.find(token);
    const scopes = r ? this.scopesOf(r) : [];
    if (!r || scopes.length === 0) return null;
    return { id: r.id as string, hashPrefix: (r.hash as string).slice(7, 15), scopes };
  }
}
