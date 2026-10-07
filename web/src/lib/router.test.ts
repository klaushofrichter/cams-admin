import { describe, expect, it } from 'vitest';
import { parse } from './router';

describe('router', () => {
  it.each([
    ['', { page: 'dashboard' }], ['#/', { page: 'dashboard' }], ['#/accounts', { page: 'accounts' }],
    ['#/accounts/acc_1', { page: 'account', accountId: 'acc_1', tab: 'overview' }], ['#/accounts/acc_1/users', { page: 'account', accountId: 'acc_1', tab: 'users' }],
    ['#/accounts/acc_1/proxies/prx_2', { page: 'proxy', accountId: 'acc_1', proxyId: 'prx_2' }], ['#/audit', { page: 'audit' }], ['#/backup', { page: 'backup' }], ['#/cams-instances', { page: 'cams-instances' }], ['#/cams-instances/cms_1', { page: 'cams-instance', instanceId: 'cms_1' }], ['#/nope', { page: 'dashboard' }],
  ])('%s', (h, r) => expect(parse(h)).toEqual(r));
});
