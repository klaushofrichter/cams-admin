import { describe, expect, it } from 'vitest';
import { commandsText, cmdStateClass, cmdStateText, tokenStateClass, issueBlocked } from './commands';

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
});
