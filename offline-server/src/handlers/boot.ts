// 부트 핸들러: MsgLoginReq -> [MsgLoginAns, MsgUserData]
// MsgUserData 는 계정 상태 스냅샷 전체. 저장된 유저가 없으면 시드(data/userdata-seed.json)를,
// 시드도 없으면 신규계정 최소 스냅샷을 사용한다.
import { readFileSync, existsSync } from 'node:fs';
import { register, type Ctx, type Msg } from '../rpc.js';

const SEED = new URL('../../data/userdata-seed.json', import.meta.url).pathname;

function newAccountSnapshot(): any {
  // Completion===1 이면 클라이언트가 신규계정으로 보고 튜토리얼을 탄다.
  return {
    Seq: 1,
    UserInfo: { Completion: 1, Level: 1, Exp: 0 },
    Cars: {}, Items: {}, MyGirls: {}, GirlItems: {},
    PropertySet: {}, StoreSet: {}, MailBox: {}, SocialBox: {},
    Collections: {}, Cosmetics: {}, NquestInfos: {}, RaceZones: {},
  };
}

function applyCheat(snap: any, cheat: Record<string, boolean>): any {
  if (!cheat.enabled) return snap;
  const s = structuredClone(snap);
  if (cheat.maxCurrency && s.PropertySet) {
    for (const k of Object.keys(s.PropertySet)) {
      if (typeof s.PropertySet[k] === 'number') s.PropertySet[k] = 999_999_999;
    }
  }
  // unlockAllCars / unlockAllGirls 는 content 테이블을 순회해 보유로 채우는 로직을 2단계에서 추가.
  return s;
}

function loadSnapshot(ctx: Ctx): any {
  const stored = ctx.store.getUser(ctx.session.accountId);
  if (stored) return stored;
  if (existsSync(SEED)) {
    const seed = JSON.parse(readFileSync(SEED, 'utf8'));
    // 시드가 {messages:[...]} 형태(캡처 원본)이면 MsgUserData 바디를 추출.
    const body = seed?.messages
      ? seed.messages.find((m: any) => m.name === 'MsgUserData')?.body
      : seed;
    if (body) {
      ctx.store.putUser(ctx.session.accountId, body);
      return body;
    }
  }
  const fresh = newAccountSnapshot();
  ctx.store.putUser(ctx.session.accountId, fresh);
  return fresh;
}

register('MsgLoginReq', (_body, ctx): Msg[] => {
  const snap = applyCheat(loadSnapshot(ctx), ctx.cheat);
  return [
    { name: 'MsgLoginAns', body: { Seq: 1, Result: 0, Accountid: ctx.session.accountId } },
    { name: 'MsgUserData', body: snap },
  ];
});

// 옵션/완료도 갱신은 상태만 저장하고 빈 Ans 를 돌려준다(메인 진입에 필요).
register('MsgSetOptionReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId) ?? newAccountSnapshot();
  snap.Options = { ...(snap.Options ?? {}), ...(body ?? {}) };
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgSetOptionAns', body: { Result: 0 } }];
});

register('MsgUpdateCompletionReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId) ?? newAccountSnapshot();
  if (snap.UserInfo && body?.Completion != null) snap.UserInfo.Completion = body.Completion;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgUpdateCompletionAns', body: { Result: 0, Completion: snap.UserInfo?.Completion } }];
});
