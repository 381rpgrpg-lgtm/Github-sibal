// 인증. 오프라인 단일 유저이므로 느슨 모드가 기본: 어떤 login/password 조합도 통과시키고
// 로컬 토큰·sigKey를 발급한다. strictSignatures=true 로 두면 원격 분리 시 서명 검증을 켠다.
import { randomBytes, createHmac, createHash } from 'node:crypto';

export interface Session {
  token: string;
  sigKey: string; // base64url
  accountId: string;
  expires: number;
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export class Auth {
  private sessions = new Map<string, Session>(); // token -> session
  constructor(private strict: boolean) {}

  login(login: string, _password: string): { session: Session; accountId: string } {
    // 오프라인: 로그인명으로 안정적인 accountId 를 만든다(같은 이름=같은 저장상태).
    const accountId = String(1_000_000 + (hashInt(login || 'offline') % 8_999_999));
    const session: Session = {
      token: b64url(randomBytes(24)),
      sigKey: b64url(randomBytes(24)),
      accountId,
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
    };
    this.sessions.set(session.token, session);
    return { session, accountId };
  }

  bearer(authHeader: string | undefined): Session | null {
    if (!authHeader) return null;
    const m = /^Bearer\s+(.+)$/.exec(authHeader);
    if (!m) return null;
    return this.sessions.get(m[1]) ?? null;
  }

  // 느슨 모드: 토큰만 있으면 통과. 엄격 모드: x-dg-s HMAC 검증.
  verify(req: { method: string; path: string; search: string; body: string; headers: Record<string, string | undefined> }): Session | null {
    const session = this.bearer(req.headers['authorization']);
    if (!session) return null;
    if (!this.strict) return session;
    const nonce = req.headers['x-dg-c'];
    const sig = req.headers['x-dg-s'];
    if (!nonce || !sig) return null;
    const bodyHash = createHash('sha256').update(req.body ?? '').digest('hex');
    const msg = `${req.method}\n${req.path}${req.search}\n${nonce}\n${bodyHash}`;
    const expect = b64url(createHmac('sha256', b64urlDecode(session.sigKey)).update(msg).digest());
    return expect === sig ? session : null;
  }
}

// 응답 서명: x-dg-s = base64url(HMAC_SHA256(sigKey, "res\n" + 요청 nonce + "\n" + sha256hex(응답본문)))
// 클라이언트는 인증 요청의 응답에 이 헤더가 없거나 다르면 "The answer was altered on the way." 로 거부한다.
export function signResponse(session: Session, nonce: string, bodyText: string): string {
  const bodyHash = createHash('sha256').update(bodyText).digest('hex');
  return b64url(createHmac('sha256', b64urlDecode(session.sigKey)).update(`res\n${nonce}\n${bodyHash}`).digest());
}

function hashInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
