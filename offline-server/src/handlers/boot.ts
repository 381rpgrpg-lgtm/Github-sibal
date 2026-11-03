// 부트 핸들러: MsgLoginReq -> [MsgLoginAns, MsgUserData]
// MsgUserData 는 계정 상태 스냅샷 전체. 저장된 유저가 없으면 시드(data/userdata-seed.json)를,
// 시드도 없으면 신규계정 최소 스냅샷을 사용한다.
import { readFileSync, existsSync } from 'node:fs';
import { dailyReset } from '../daily.js';
import { register, type Ctx, type Msg } from '../rpc.js';
import { refreshQuests } from '../quests.js';

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

// 출석 보상(Daygift): 일일 초기화(daily.ts)가 일어난 로그인에만 MsgUserData 에 넣는다 (실기록: 그날 두 번째 로그인부터 없음).
//   빈 Daygift 는 빈 '획득 아이템' 팝업을 띄우므로 초기화가 없으면 필드 자체를 뺀다.
function dailyGift(snap: any): void {
  const d = dailyReset(snap);
  if (d) snap.Daygift = d.Daygift; else delete snap.Daygift;
}

register('MsgLoginReq', (_body, ctx): Msg[] => {
  const base = loadSnapshot(ctx);
  dailyGift(base);
  // LevelUp 은 로그인 데이터에도 그대로 남는다 (실기록 2026-11-02: 레벨업 뒤 다음 레이스 결과 전까지의 모든 로그인)
  refreshQuests(base); // 조건이 맞는 퀘스트를 제시 상태로 (실계정 로그인 데이터에도 State 2 퀘스트가 들어 있음)
  ctx.store.putUser(ctx.session.accountId, base);
  // 이벤트 공지 팝업(로그인마다 재표시)은 오프라인 기본값에서 끈다. config.showNotices=true 로 켬.
  if (!ctx.showNotices && base.NoticeInfo) base.NoticeInfo = { ...base.NoticeInfo, Notice: [] };
  const snap = applyCheat(base, ctx.cheat);
  return [
    { name: 'MsgLoginAns', body: { Seq: 1, Result: 1, Accountid: ctx.session.accountId } },
    { name: 'MsgUserData', body: snap },
  ];
});

// 옵션/완료도 갱신은 상태만 저장하고 빈 Ans 를 돌려준다(메인 진입에 필요).
register('MsgSetOptionReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId) ?? newAccountSnapshot();
  snap.Options = { ...(snap.Options ?? {}), ...(body ?? {}) };
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgSetOptionAns', body: { Result: 1 } }];
});

// 튜토리얼 단계 완료: {UserInfo:{Completion: 비트}} -> {Seq, Result 1, UserInfo[, CarInfo]}
// 실서버 기록(2026-11-01): 요청 비트를 기존 값에 OR (1024, 16384, 917504 각각 더해짐).
//   917504 = SlotOpenParts|ReinforceParts|AddParts 튜토리얼: 응답 CarInfo 의 현재 차량 SlotNum 1 -> 2 (튜토리얼 슬롯 무료 개방).
const TUT_SLOT_OPEN_PARTS = 131072;
register('MsgUpdateCompletionReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId) ?? newAccountSnapshot();
  const bits = Number(body?.UserInfo?.Completion ?? body?.Completion) || 0;
  const ui = snap.UserInfo ?? (snap.UserInfo = {});
  const before = Number(ui.Completion) || 0;
  ui.Completion = before | bits;
  let car: any = null;
  if (bits & TUT_SLOT_OPEN_PARTS && !(before & TUT_SLOT_OPEN_PARTS)) {
    car = (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(ui.Currentcar)) ?? null;
    if (car && (Number(car.SlotNum) || 1) < 2) car.SlotNum = 2;
  }
  // 튜토리얼 단계 완료 보상 (실기록: 128 UseInventory 300코인, 2048 Memory 300코인, 1048576 CarPerformance 500코인.
  //   1024·16384·917504 는 보상 없음. 나머지 단계는 기록 없음 -> 보상 없음)
  const REWARD: Record<number, number> = { 128: 300, 2048: 300, 1048576: 500 };
  let coin = 0;
  for (const [bit, c] of Object.entries(REWARD)) if (bits & Number(bit) && !(before & Number(bit))) coin += c;
  if (coin) ui.Coin = (Number(ui.Coin) || 0) + coin;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgUpdateCompletionAns', body: { Seq: 1, Result: 1, UserInfo: ui, ...(car ? { CarInfo: car } : {}),
    ...(coin ? { RewardInfo: { Coin: coin, Cash: 0, Charexp: 0, ItemInfo: [{ Itemtype: 61001, Count: coin, DeltaNum: coin }], CarInfo: [] } } : {}) } }];
});

// 코스메틱 '확인함' 표시: New=false 로 저장하고 갱신된 Cosmetics 를 돌려준다.
register('MsgCosmeticSeenReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (snap && Array.isArray(body?.Ids)) {
    const ids = new Set(body.Ids.map(String));
    for (const c of snap.Cosmetics?.Owned ?? []) if (ids.has(String(c.Id))) c.New = false;
    if (snap.Cosmetics) snap.Cosmetics.Version = (snap.Cosmetics.Version ?? 0) + 1;
    ctx.store.putUser(ctx.session.accountId, snap);
    // 클라이언트는 모든 응답 본문에 공통 patch 를 적용한다: Cosmetics.Owned 가 오면 상태를 교체.
    return [{ name: 'MsgCosmeticSeenAns', body: { Result: 1, Cosmetics: snap.Cosmetics } }];
  }
  return [];
});
