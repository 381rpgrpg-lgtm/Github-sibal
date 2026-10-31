#!/usr/bin/env python3
"""
서버 인증 헬퍼 (평문 엔드포인트용). 본인 계정 로그인 후 서명된 GET/POST 요청을 보낸다.
암호화 팩 복호화(api/keys)는 다루지 않는다.

사용 예:
    python3 sign.py login <id> <pw>                 -> login.json 저장
    python3 sign.py get /api/content                -> out.bin 저장
    python3 sign.py get /api/scripts                -> out.bin 저장
    python3 sign.py rpc MsgLoginReq                  -> out.bin 저장

로그인 세션(login.json)은 같은 폴더에 저장/재사용된다.
"""
import json, time, hmac, hashlib, base64, sys, os, urllib.request, urllib.error

BASE = 'https://game.driftgirlsreborn.com'
UA = 'DriftGirlsReborn/1.0.4 (Android 14)'
HERE = os.path.dirname(os.path.abspath(__file__))
SPATH = os.path.join(HERE, 'login.json')


def b64url(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')


def b64url_dec(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def current_build():
    req = urllib.request.Request(BASE + '/api/login', method='POST',
                                 data=b'{}', headers={'content-type': 'application/json',
                                                      'x-dg-build': 'probe', 'user-agent': UA})
    try:
        urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        return json.loads(e.read()).get('build')
    return None


def do_login(login, pw):
    build = current_build()
    body = json.dumps({'login': login, 'password': pw}).encode()
    req = urllib.request.Request(BASE + '/api/login', method='POST', data=body,
                                 headers={'content-type': 'application/json',
                                          'x-dg-build': build, 'user-agent': UA})
    s = json.loads(urllib.request.urlopen(req, timeout=30).read())
    s['build'] = build
    json.dump(s, open(SPATH, 'w'))
    print('로그인 성공. account', s.get('account'), 'build', build)
    return s


def call(path, method='GET', body_obj=None):
    s = json.load(open(SPATH))
    bodystr = '' if method == 'GET' or body_obj is None else json.dumps(body_obj, separators=(',', ':'))
    nonce = str(int(time.time() * 1_000_000))
    bodyhash = hashlib.sha256(bodystr.encode()).hexdigest()
    msg = f'{method}\n{path}\n{nonce}\n{bodyhash}'
    sig = b64url(hmac.new(b64url_dec(s['sigKey']), msg.encode(), hashlib.sha256).digest())
    h = {'content-type': 'application/json', 'x-dg-build': s['build'],
         'authorization': 'Bearer ' + s['token'], 'x-dg-c': nonce, 'x-dg-s': sig, 'user-agent': UA}
    data = None if method == 'GET' else bodystr.encode()
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(0)
    if a[0] == 'login':
        do_login(a[1], a[2])
    elif a[0] == 'get':
        st, body = call(a[1], 'GET'); open(os.path.join(HERE, 'out.bin'), 'wb').write(body)
        print('HTTP', st, 'bytes', len(body), '-> out.bin')
    elif a[0] == 'rpc':
        st, body = call('/api/rpc', 'POST', {'name': a[1], 'body': json.loads(a[2]) if len(a) > 2 else {}})
        open(os.path.join(HERE, 'out.bin'), 'wb').write(body)
        print('HTTP', st, 'bytes', len(body), '-> out.bin')
    else:
        print(__doc__)
