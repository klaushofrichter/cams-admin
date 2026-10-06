import { describe, expect, it } from 'vitest';
import { commandsText, cmdStateClass, cmdStateText, tokenStateClass, tokenStateText, issueBlocked, aheadText } from './commands';

describe('commands (UI text)', () => {
  it('the proxy\'s command policy', () => {
    expect(commandsText('unsupported')).toBe('this proxy version takes no commands');
    expect(commandsText('off')).toBe('commands are off on the proxy (environment)');
    expect(commandsText('paused')).toBe('paused on the proxy');
    expect(commandsText('none-allowed')).toBe('no command allowed on the proxy');
    expect(commandsText('allowed', ['tokens.apply', 'tokens.apply.admin'])).toBe('allowed: tokens.apply, tokens.apply.admin');
    expect(commandsText(undefined)).toBe('this proxy version takes no commands');
  });
  it('command states', () => {
    expect(cmdStateText('done', null)).toBe('done');
    expect(cmdStateText('refused', 'paused')).toBe('refused: paused');
    expect(cmdStateText('failed', 'store_error')).toBe('failed: store_error');
    expect(cmdStateText('unknown', null)).toBe("unknown: check the proxy's audit log");
    for (const s of ['queued', 'sent', 'received', 'expired']) expect(cmdStateText(s, null)).toBe(s);
    expect(cmdStateClass('done')).toBe('ok');
    expect(cmdStateClass('refused')).toBe('bad');
    expect(cmdStateClass('failed')).toBe('bad');
    expect(cmdStateClass('unknown')).toBe('warn');
    expect(cmdStateClass('expired')).toBe('warn');
    expect(cmdStateClass('sent')).toBe('');
  });
  it('token states and why an issue button is disabled', () => {
    expect(tokenStateClass('active')).toBe('ok');
    expect(tokenStateClass('retiring')).toBe('warn');
    expect(tokenStateClass('revoked')).toBe('bad');
    expect(tokenStateClass('pending')).toBe('');
    expect(issueBlocked('client', 'allowed', ['tokens.apply'])).toBeNull();
    expect(issueBlocked('admin', 'allowed', ['tokens.apply'])).toBe('the proxy does not allow tokens.apply.admin');
    expect(issueBlocked('admin', 'allowed', ['tokens.apply', 'tokens.apply.admin'])).toBeNull();
    expect(issueBlocked('client', 'allowed', ['config.get'])).toBe('the proxy does not allow tokens.apply');
    expect(issueBlocked('client', 'paused', ['tokens.apply'])).toBe('paused on the proxy');
  });
  it('a revoke not yet on the proxy, and a proxy ahead after a restore', () => {
    expect(tokenStateText({ state: 'revoked', onProxy: false })).toBe('revoked, not yet on proxy');
    expect(tokenStateText({ state: 'revoked', onProxy: true })).toBe('revoked');
    expect(tokenStateText({ state: 'active', onProxy: true })).toBe('active');
    expect(tokenStateClass('revoked', false)).toBe('warn');
    expect(aheadText(12, 3)).toBe('The proxy is at token revision 12, ahead of cams-admin (3): was cams-admin restored from a backup? Check the tokens below (re-revoke what was revoked after the backup), then confirm.');
  });
});
