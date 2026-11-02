// /api/rpc 디스패처. name 으로 핸들러를 찾아 messages[] 를 돌려준다.
// 클라이언트 계약: POST /api/rpc {name, body} -> {messages:[{name, body}, ...]}
import type { Store } from './db.js';
import type { GameData } from './content.js';
import type { Session } from './auth.js';
import type { Upstream } from './upstream.js';
import { achBefore, achAfter } from './achievements.js';
import { dailyReset } from './daily.js';

export interface Ctx {
  store: Store;
  data: GameData;
  session: Session;
  cheat: Record<string, boolean>;
  showNotices?: boolean;
  upstream?: Upstream | null;
}

export interface Msg {
  name: string;
  body: any;
}

export type Handler = (body: any, ctx: Ctx) => Msg[] | Promise<Msg[]>;

const handlers = new Map<string, Handler>();
const LEVELUP_MSGS = new Set(['MsgBattleStartAns', 'MsgBattleResultAns', 'MsgRaceRewardAns', 'MsgScriptProgressAns', 'MsgDateResultAns', 'MsgUserData', 'MsgLoginAns']);
const RECORD_ALWAYS = new Set((process.env.DG_RECORD_ALWAYS ?? '').split(',').map((x) => x.trim()).filter(Boolean));

export function register(name: string, fn: Handler): void {
  handlers.set(name, fn);
}

export async function dispatch(name: string, body: any, ctx: Ctx): Promise<{ messages: Msg[] } | { error: string }> {
  const fn = handlers.get(name);
  // 기록 강제 목록(DG_RECORD_ALWAYS=Msg1,Msg2): 로컬 구현이 있어도 실서버 응답을 기록하기 위해 보낸다.
  // DG_RECORD_ALWAYS='*' 는 전체 중계: 로그인부터 모든 메시지를 실서버 계정으로 처리하고 기록한다(로컬 DB 는 건드리지 않음).
  //   로컬 진행 상태와 실계정 상태가 달라 실서버가 거절하는 기능(예: 로컬에서만 해금된 데이트)을 실계정 흐름 그대로 녹화할 때 쓴다.
  if (ctx.upstream && (RECORD_ALWAYS.has(name) || RECORD_ALWAYS.has('*'))) {
    try {
      const up = await ctx.upstream.rpc(name, body);
      const messages: Msg[] = Array.isArray(up?.messages) ? up.messages : [];
      console.log(`[rpc] ${name} -> (upstream, 강제 기록) ${messages.map((m) => m.name).join(',') || '(none)'}`);
      return { messages };
    } catch (e) {
      console.warn(`[rpc] ${name} upstream 실패, 로컬 처리로 전환: ${(e as Error).message}`);
    }
  }
  if (!fn) {
    // 기록 모드: 실서버(사용자 계정)로 보내 응답을 그대로 돌려주고 data/recorded/ 에 저장.
    if (ctx.upstream) {
      try {
        const up = await ctx.upstream.rpc(name, body);
        const messages: Msg[] = Array.isArray(up?.messages) ? up.messages : [];
        console.log(`[rpc] ${name} -> (upstream) ${messages.map((m) => m.name).join(',') || '(none)'}`);
        return { messages };
      } catch (e) {
        console.warn(`[rpc] ${name} upstream 실패: ${(e as Error).message}`);
      }
    }
    // 아직 미구현 메시지: 비어있지 않은 명시적 에러로 로그에 남긴다.
    console.warn(`[rpc] 미구현 메시지: ${name} ${JSON.stringify(body).slice(0, 2000)}`);
    return { error: `unimplemented:${name}` };
  }
  // 업적 진행: 핸들러 전후 상태를 비교하고 메시지별 사건을 반영 (achievements.ts)
  const id = ctx.session?.accountId;
  // 일일 초기화 (daily.ts): 로그인은 핸들러가 MsgUserData 에 담고, 그 외 요청은 끝에 MsgNotifyEvent 3개를 붙인다
  let daily: ReturnType<typeof dailyReset> = null;
  let preSnap = id && name !== 'MsgLoginReq' ? ctx.store.getUser(id) : null;
  if (preSnap && id) { daily = dailyReset(preSnap); if (daily) ctx.store.putUser(id, preSnap); }
  const pre = preSnap ? achBefore(preSnap) : null;
  preSnap = null;
  const messages = await fn(body, ctx);
  if (pre && id) {
    const snap = ctx.store.getUser(id);
    if (achAfter(snap, pre, name, body, messages)) ctx.store.putUser(id, snap);
  }
  if (daily && id) {
    const snap = ctx.store.getUser(id);
    const seq = Number(messages[messages.length - 1]?.body?.Seq) || messages.length;
    messages.push(
      { name: 'MsgNotifyEvent', body: { Seq: seq + 1, PropertySet: snap?.PropertySet } },
      { name: 'MsgNotifyEvent', body: { Seq: seq + 2, Daygift: daily.Daygift, MailBox: snap?.MailBox } },
      { name: 'MsgNotifyEvent', body: { Seq: seq + 3, DailyRewardRaces: daily.DailyRewardRaces } },
    );
  }
  // UserInfo.LevelUp 은 레이스·데이트 응답에만 실린다 (실기록: 레벨업 뒤 RaceReward·BattleStart·DateResult 에는 있고
  //   UpdateNquest·UpdateCompletion·CollectFamiliarity 에는 없음). 저장값은 다음 레이스 결과까지 유지.
  for (const m of messages) {
    if (!LEVELUP_MSGS.has(m.name) && m.body?.UserInfo?.LevelUp) {
      const { LevelUp: _drop, ...rest } = m.body.UserInfo;
      m.body = { ...m.body, UserInfo: rest };
    }
  }
  console.log(`[rpc] ${name} -> ${messages.map((m) => m.name).join(',') || '(none)'}`);
  return { messages };
}
