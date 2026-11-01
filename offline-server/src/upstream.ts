// 기록 모드(개발용): 로컬에 구현되지 않은 RPC 를 사용자 본인 계정으로 실서버에 보내고,
// 요청/응답을 data/recorded/ 에 저장해 로컬 구현의 근거로 쓴다.
// 켜는 법: DG_RECORD=1 DG_LOGIN=<id> DG_PASSWORD=<pw> npm start   (자격증명은 환경변수로만 받는다)
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'DriftGirlsReborn/1.0.4 (Android 14)';
const REC_DIR = new URL('../data/recorded/', import.meta.url).pathname;
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDec = (s: string) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export class Upstream {
  private session: any = null;
  private counter = 0;
  private seq = 0;
  constructor(private base: string, private login: string, private password: string) {}

  static fromEnv(base: string): Upstream | null {
    if (process.env.DG_RECORD !== '1') return null;
    const { DG_LOGIN, DG_PASSWORD } = process.env;
    if (!DG_LOGIN || !DG_PASSWORD) {
      console.warn('[record] DG_RECORD=1 이지만 DG_LOGIN/DG_PASSWORD 가 없어 기록 모드를 끕니다.');
      return null;
    }
    return new Upstream(base, DG_LOGIN, DG_PASSWORD);
  }

  private async build(): Promise<string> {
    // 잘못된 build 로 login 하면 426 바디에 현재 build 가 온다.
    const r = await fetch(this.base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dg-build': 'probe', 'user-agent': UA },
      body: '{}',
    });
    const j: any = await r.json().catch(() => ({}));
    if (!j.build) throw new Error('upstream build 확인 실패');
    return j.build;
  }

  private async ensure(): Promise<void> {
    if (this.session && this.session.expires > Date.now() / 1000 + 60) return;
    const build = await this.build();
    const r = await fetch(this.base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dg-build': build, 'user-agent': UA },
      body: JSON.stringify({ login: this.login, password: this.password }),
    });
    if (!r.ok) throw new Error('upstream login HTTP ' + r.status);
    this.session = { ...(await r.json()), build };
    console.log('[record] upstream 로그인 OK, build', build);
  }

  async rpc(name: string, body: any): Promise<any> {
    await this.ensure();
    const path = '/api/rpc';
    const bodystr = JSON.stringify({ name, body: body ?? {} });
    this.counter = Math.max(this.counter + 1, Date.now() * 1000);
    const nonce = String(this.counter);
    const msg = `POST\n${path}\n${nonce}\n${createHash('sha256').update(bodystr).digest('hex')}`;
    const sig = b64url(createHmac('sha256', b64urlDec(this.session.sigKey)).update(msg).digest());
    const r = await fetch(this.base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-dg-build': this.session.build, 'user-agent': UA,
        authorization: 'Bearer ' + this.session.token, 'x-dg-c': nonce, 'x-dg-s': sig,
      },
      body: bodystr,
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 비JSON */ }
    this.save(name, body, r.status, json ?? text);
    if (!r.ok) throw new Error(`upstream ${name} HTTP ${r.status}`);
    return json;
  }

  private save(name: string, req: any, status: number, res: any) {
    mkdirSync(REC_DIR, { recursive: true });
    const file = join(REC_DIR, `${String(++this.seq).padStart(4, '0')}_${Date.now()}_${name}.json`);
    writeFileSync(file, JSON.stringify({ name, request: req, status, response: res }, null, 1));
    console.log(`[record] ${name} -> HTTP ${status} 저장: ${file}`);
  }
}

export function loadRecorded(name: string): any[] {
  if (!existsSync(REC_DIR)) return [];
  return readdirSync(REC_DIR).filter((f: string) => f.endsWith(`_${name}.json`)).map((f: string) => JSON.parse(readFileSync(join(REC_DIR, f), 'utf8')));
}
