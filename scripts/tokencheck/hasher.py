# token-check hasher (docs/token-check.md). Runs where the files are: on the
# Mac, or on a host through `ssh <host> python3 -` with this program on stdin.
# It reads secret files only to fingerprint them and prints JSON that never
# holds a value:
#   fp  = HMAC-SHA256(run key, value), 12 hex: compares copies within one run
#         (the run key is random per run, so fp is useless afterwards)
#   sha = SHA-256(value), 12 hex, only for high-entropy tokens: matches
#         cam-proxy's and cams-admin's stored `sha256:` hashes
# The orchestrator appends `main(<spec>)` to this source; the spec (with the
# run key) travels on stdin, never on a command line. Python standard library
# only (python3 on every host). Errors report the exception type, never a
# message (a message could quote file content).
import glob as _glob
import hashlib
import hmac
import json
import os
import stat
import subprocess
import sys
import urllib.request

FP_LEN = 12
SHA_LEN = 12


class Ctx:
    def __init__(self, key_hex, mounts):
        self.key = bytes.fromhex(key_hex)
        self.mounts = mounts or {}

    def fp(self, value):
        return hmac.new(self.key, value.encode('utf-8'), hashlib.sha256).hexdigest()[:FP_LEN]


def sha(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def is_token_name(name):
    return 'TOKEN' in name.upper()


def fingerprint(ctx, value, token):
    out = {'fp': ctx.fp(value)}
    if token:
        out['sha'] = sha(value)[:SHA_LEN]
    return out


def file_meta(path):
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return {'exists': False}
    return {'exists': True, 'mode': oct(stat.S_IMODE(st.st_mode))[2:].rjust(3, '0')}


def read_text(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def strip_nl(s):
    return s.rstrip('\r\n')


def parse_env(text):
    out = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        if s.startswith('export '):
            s = s[7:].lstrip()
        if '=' not in s:
            continue
        k, v = s.split('=', 1)
        k = k.strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        out[k] = v
    return out


def map_path(ctx, p):
    for prefix, host in ctx.mounts.items():
        if p.startswith(prefix):
            return host + p[len(prefix):]
    return p


def secret_value(ctx, name, raw, token):
    if name.upper().endswith('TOKENS'):
        parts = [x.strip() for x in raw.split(',') if x.strip()]
        return {'list': [fingerprint(ctx, x, True) for x in parts]}
    if raw == '':
        return {'empty': True}
    return fingerprint(ctx, raw, token)


SECRET_WORDS = ('TOKEN', 'PASSWORD', 'SECRET', 'KEY')


def want_name(name, it):
    names = it.get('secrets') or []
    pre = it.get('prefixes') or []
    return name in names or (any(name.startswith(p) for p in pre) and any(w in name for w in SECRET_WORDS))


def do_env(ctx, it, path=None):
    path = path or it['path']
    res = file_meta(path)
    if not res['exists']:
        return res
    env = parse_env(read_text(path))
    vars_ = {}
    for name, raw in env.items():
        base = name[:-5] if name.endswith('_FILE') else name
        if not want_name(base, it):
            continue
        token = is_token_name(base)
        if name.endswith('_FILE'):
            host_path = map_path(ctx, raw)
            meta = file_meta(host_path)
            entry = {'via': 'file', 'file': os.path.basename(host_path), **meta}
            if meta['exists']:
                entry.update(secret_value(ctx, base, strip_nl(read_text(host_path)), token))
            vars_[base] = entry
        else:
            vars_[base] = {'via': 'env', **secret_value(ctx, base, raw, token)}
    res['vars'] = vars_
    res['plain'] = {n: env[n] for n in it.get('plain', []) if n in env}
    return res


def do_file(ctx, it):
    res = file_meta(it['path'])
    if res['exists']:
        kind = it.get('kind', 'secret')
        val = strip_nl(read_text(it['path']))
        if kind == 'list':
            res['list'] = [fingerprint(ctx, x.strip(), True) for x in val.split(',') if x.strip()]
        elif val == '':
            res['empty'] = True
        else:
            res.update(fingerprint(ctx, val, kind == 'token'))
    return res


def do_json(ctx, it):
    res = file_meta(it['path'])
    if not res['exists']:
        return res
    data = json.loads(read_text(it['path']))
    secrets = set(it.get('secrets', []))
    context = set(it.get('context', []))
    hash_field = it.get('hashField')
    entries = []

    def walk(node, path, inherited):
        if isinstance(node, dict):
            own = {k: node[k] for k in context if k in node and isinstance(node[k], (str, int, float, bool, type(None)))}
            here = {**inherited, **own}
            found = {k: v for k, v in node.items() if k in secrets and isinstance(v, str) and v}
            if found:
                e = {'path': '.'.join(path), 'ctx': here, 'secrets': {}}
                for k, v in found.items():
                    e['secrets'][k] = fingerprint(ctx, v, k.lower().endswith('token'))
                    if hash_field and isinstance(node.get(hash_field), str) and k == 'token':
                        e['hashOk'] = node[hash_field] == 'sha256:' + sha(v)
                entries.append(e)
            for k, v in node.items():
                if k not in secrets:
                    walk(v, path + [str(k)], here)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, path + [str(i)], inherited)

    walk(data, [], {})
    res['entries'] = entries
    return res


def do_files(ctx, it):
    out = []
    for p in sorted(_glob.glob(it['pattern'])):
        r = do_file(ctx, {**it, 'path': p})
        r['name'] = os.path.basename(p)
        out.append(r)
    return {'files': out}


def do_camusers(ctx, it):
    res = file_meta(it['path'])
    if not res['exists']:
        return res
    c = json.loads(read_text(it['path']))
    users = {}
    cams = c.get('cameras')
    if isinstance(cams, list):
        for x in cams:
            if isinstance(x, dict) and isinstance(x.get('id'), str):
                users[x['id']] = x.get('user') if isinstance(x.get('user'), str) else None
    elif isinstance(cams, dict):
        for k, x in cams.items():
            if isinstance(x, dict):
                users[k] = x.get('user') if isinstance(x.get('user'), str) else None
    if isinstance(c.get('camera'), dict):
        x = c['camera']
        users[x.get('id') if isinstance(x.get('id'), str) else 'cam1'] = x.get('user') if isinstance(x.get('user'), str) else None
    res['users'] = users
    return res


def key_fp(b64):
    import base64
    return 'SHA256:' + hashlib.sha256(base64.b64decode(b64)).hexdigest().upper()


def do_keyfile(ctx, it):
    res = file_meta(it['path'])
    if not res['exists']:
        return res
    k = json.loads(read_text(it['path']))
    res['serverKeyFingerprints'] = [key_fp(x) for x in k.get('serverKeys', []) if isinstance(x, str)]
    if isinstance(k.get('publicKey'), str):
        res['publicKeyFingerprint'] = key_fp(k['publicKey'])
    for f in ('proxyId', 'instanceId', 'instanceName', 'account', 'accounts', 'url', 'enrolledAt'):
        if f in k:
            res[f] = k[f]
    return res


def do_pem(ctx, it):
    res = file_meta(it['path'])
    if not res['exists']:
        return res
    # openssl reads the private key itself; only the public key's DER comes back.
    der = subprocess.run(['openssl', 'pkey', '-in', it['path'], '-pubout', '-outform', 'DER'], capture_output=True, check=True).stdout
    res['fingerprint'] = 'SHA256:' + hashlib.sha256(der).hexdigest().upper()
    return res


def do_cache(ctx, it):
    res = file_meta(it['path'])
    if not res['exists']:
        return res
    c = json.loads(read_text(it['path']))
    inst = c.get('instance') or {}
    res['instance'] = {'id': inst.get('id'), 'name': inst.get('name')}
    res['revision'] = c.get('revision')
    res['accounts'] = [{
        'id': a.get('id'), 'name': a.get('name'),
        'proxies': [{'id': p.get('id'), 'name': p.get('name'), 'caFingerprints': p.get('caFingerprints') or []} for p in a.get('proxies') or []],
        'viewerTokens': len(a.get('viewerTokens') or []),
    } for a in c.get('accounts') or []]
    return res


def do_glob(ctx, it):
    out = []
    for p in sorted(_glob.glob(it['pattern'])):
        r = do_env(ctx, it, p)
        r['name'] = os.path.basename(p)
        out.append(r)
    return {'files': out}


def api_token(ctx, spec):
    env = parse_env(read_text(spec['path']))
    name = spec['name']
    if env.get(name + '_FILE'):
        return strip_nl(read_text(map_path(ctx, env[name + '_FILE'])))
    return env.get(name)


def do_api(ctx, it):
    tok = api_token(ctx, it['token'])
    if not tok:
        return {'error': 'no_admin_token'}
    base = it['base']

    def get(p):
        req = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)

    out = {}
    try:
        a = get('/control/admin')
        out['admin'] = {k: a.get(k) for k in ('state', 'account', 'proxyId', 'fingerprint', 'enrolledAt', 'lastHeartbeatAt', 'lastError')}
    except Exception as e:  # noqa: BLE001
        out['admin'] = {'error': type(e).__name__}
    try:
        t = get('/control/admin/tokens')
        out['tokens'] = {'revision': t.get('revision'), 'problem': t.get('problem'), 'items': [{k: x.get(k) for k in ('id', 'kind', 'label', 'retireAt', 'blocked', 'live', 'hashPrefix')} for x in t.get('items') or []]}
    except Exception as e:  # noqa: BLE001
        out['tokens'] = {'error': type(e).__name__}
    try:
        t = get('/control/tls')
        out['tls'] = {'site': t.get('site'), 'caFingerprint': t.get('caFingerprint'), 'caNotAfter': t.get('caNotAfter'),
                      'proxy': {'notAfter': (t.get('proxy') or {}).get('notAfter')},
                      'cameras': [{k: c.get(k) for k in ('id', 'mode', 'notAfter', 'problem')} for c in t.get('cameras') or []]}
    except Exception as e:  # noqa: BLE001
        out['tls'] = {'error': type(e).__name__}
    try:
        cams = get('/control/cameras')
        out['cameras'] = []
        for c in cams:
            f = c.get('ftp') or {}
            fc = f.get('camera') or {}
            cr = c.get('credentials') or {}
            out['cameras'].append({
                'id': c.get('id'), 'source': c.get('source'), 'online': (c.get('camera') or {}).get('online'),
                'credentials': {k: cr.get(k) for k in ('source', 'envName', 'authOk', 'checkedAt')},
                'ftp': {'enabled': f.get('enabled'), 'passwordSet': f.get('passwordSet'), 'lastUpload': f.get('lastUpload'), 'failures': f.get('failures'),
                        'stalled': bool((f.get('stalled') or {}).get('stalled')),
                        'camera': {'state': fc.get('state'), 'mismatch': fc.get('mismatch') or [], 'error': fc.get('error')} if fc else None},
            })
    except Exception as e:  # noqa: BLE001
        out['cameras'] = {'error': type(e).__name__}
    try:
        s = get('/control/switches')
        out['switches'] = [{k: x.get(k) for k in ('id', 'passwordSet', 'passwordElsewhere')} for x in s.get('switches') or []]
    except Exception as e:  # noqa: BLE001
        out['switches'] = {'error': type(e).__name__}
    return out


HANDLERS = {'env': do_env, 'file': do_file, 'files': do_files, 'camusers': do_camusers, 'json': do_json, 'keyfile': do_keyfile, 'pem': do_pem, 'cache': do_cache, 'glob': do_glob, 'api': do_api}


def main(spec):
    ctx = Ctx(spec['key'], spec.get('mounts'))
    items = {}
    for it in spec.get('items', []):
        try:
            items[it['id']] = HANDLERS[it['type']](ctx, it)
        except Exception as e:  # noqa: BLE001
            items[it['id']] = {'error': type(e).__name__}
    sys.stdout.write(json.dumps({'v': 1, 'items': items}))
    sys.stdout.write('\n')
