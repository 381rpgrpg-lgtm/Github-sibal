// 차고: 차량 강화. 형식은 실서버 기록(data/recorded, 2026-11-01)을 따른다.
//
// MsgUpgradeCarReq {TargetCarInfo:{Carid}, SourceCarInfo?:[{Carid}]}
//  - 튜토리얼 강화(재료 없음, Completion 에 ReinforceCar(8192) 비트가 없을 때) — 기록:
//      Result 1, UpgradeSuccess true, ResultCarInfo(UpgradeLevel 1 -> 2, Attributes 각 +2, CarExp 0),
//      NormalDeltaExp 10(= carLevelTable 해당 등급·레벨 CarExp), BonusDeltaExp 0, RemovedCarInfo [], RemovedPartsInfo [],
//      UserInfo(Completion |= 8192, 코인 차감 없음), PropertySet(DQUEST_PARTSUP 1)
//  - 재료 없이 다시 요청 — 기록: {Seq, Result 2, UserInfo}
//  - 재료 차량 강화 (실서버 실측 2026-11-01, MsgUpgradeInfoReq 5건 + MsgUpgradeCarReq 2건):
//      경험치 = 재료마다 carLevelTable[재료 등급][재료 레벨].MaterialExp 합 (★1 Lv1 10, ★2 Lv1 20, ★1 Lv3 28)
//      레벨업: CarExp 가 대상 등급의 CarExp(레벨당 필요치) 이상이면 레벨 +1, 최대 maxUpgradeLevel(10)
//      능력치 = 기존 + floor(UpgradeFactor x (새레벨-1)) - floor(UpgradeFactor x (옛레벨-1))   (TOFU 3.139: Lv1->3 각 +6)
//      비용 = 경험치 x 대상 등급 단가 (★1 8코인, ★2 32.5코인. 실측 80/160/240, 650/1560)
//      ChanceupBonus.CarLevelBonus = 재료당 6, SuccessChance 100, 재료 차량 삭제(RemovedCarInfo [{Carid}])
//  - MsgUpgradeInfoReq: 같은 계산의 예상치 {Result 1, SuccessChance, ChanceupBonus, Cost, ExpectedCarInfo}
//  - MsgSetCurrentCarReq {CarInfo:{Carid}} -> {Seq, Result 1, UserInfo}
// 추정(실측 없음): ★3 이상 대상의 단가(★1·★2 비율 4.06 배씩 증가로 가정), 재료 차량에 장착된 부품 처리(함께 삭제),
//   최대 레벨에서 남는 경험치(버림).
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';
import { bumpProperty } from './battle.js';
import { questEvent } from '../quests.js';
import { carLevelRow, carDef, upgradePreview } from './upgradecalc.js';

const TUT_REINFORCE_CAR = 8192;
const R_OK = 1, R_FAIL = 2;
const ATTRS = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];
const TABLES = new URL('../../data/tables/', import.meta.url).pathname;

let carLevels: any[] | null = null;
function levelExp(grade: number, level: number): number {
  if (!carLevels) carLevels = existsSync(TABLES + 'carLevelTable.json')
    ? JSON.parse(readFileSync(TABLES + 'carLevelTable.json', 'utf8')).CarLevels ?? [] : [];
  const g = carLevels!.find((x: any) => Number(x.Grade) === grade);
  return Number(g?.CarLevel?.find((x: any) => Number(x.Level) === level)?.CarExp) || 0;
}

register('MsgUpgradeCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const ui = snap?.UserInfo;
  const fail = (why: string): Msg[] => {
    console.warn(`[garage] 강화 거절: ${why}`);
    return [{ name: 'MsgUpgradeCarAns', body: { Seq: 1, Result: R_FAIL, ...(ui ? { UserInfo: ui } : {}) } }];
  };
  if (!snap) return fail('계정 없음');
  const car = (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(body?.TargetCarInfo?.Carid));
  if (!car) return fail('대상 차량 없음');
  const sources: any[] = body?.SourceCarInfo ?? [];
  if (sources.length) {
    const pv = upgradePreview(snap, car, sources);
    if ('error' in pv) return fail(pv.error);
    if ((Number(ui.Coin) || 0) < pv.cost) return [{ name: 'MsgUpgradeCarAns', body: { Seq: 1, Result: 3, UserInfo: ui } }];
    ui.Coin -= pv.cost;
    Object.assign(car, pv.expected);
    const ids = new Set(sources.map((x: any) => Number(x.Carid)));
    snap.Cars.CarInfo = snap.Cars.CarInfo.filter((c: any) => !ids.has(Number(c.Carid)));
    const removedParts = (snap.Items?.ItemInfo ?? []).filter((it: any) => ids.has(Number(it.Equipcarid)));
    if (removedParts.length) snap.Items.ItemInfo = snap.Items.ItemInfo.filter((it: any) => !removedParts.includes(it));
    const propChanged = bumpProperty(snap, 'DQUEST_PARTSUP', 1);
    questEvent(snap, 17, () => true); // 퀘스트: 차량 n회 강화
    ctx.store.putUser(ctx.session.accountId, snap);
    return [{ name: 'MsgUpgradeCarAns', body: {
      Seq: 1, Result: R_OK, UpgradeSuccess: true, ResultCarInfo: { ...car } /* CarEffect 는 원래 있는 차만 (실기록: 코인 상자 차량은 키 없음) */, UserInfo: ui,
      RemovedCarInfo: [...ids].map((Carid) => ({ Carid })), RemovedPartsInfo: removedParts.map((p: any) => ({ Itemid: p.Itemid })),
      NormalDeltaExp: pv.exp, BonusDeltaExp: 0,
      // PropertySet 은 일일 미션 값이 바뀐 때만 (실기록 2026-11-02: 그날 첫 강화에만 있음)
      ...(propChanged ? { PropertySet: snap.PropertySet } : {}),
    } }];
  }
  if (Number(ui.Completion) & TUT_REINFORCE_CAR) return fail('재료 없음 (튜토리얼 강화는 이미 완료)');

  // 튜토리얼 강화
  const deltaExp = levelExp(Number(car.Grade) || 1, Number(car.UpgradeLevel) || 1);
  car.UpgradeLevel = (Number(car.UpgradeLevel) || 1) + 1;
  car.CarExp = 0;
  car.Attributes ??= {};
  for (const k of ATTRS) car.Attributes[k] = (Number(car.Attributes[k]) || 0) + 2;
  ui.Completion = Number(ui.Completion) | TUT_REINFORCE_CAR;
  const propChanged = bumpProperty(snap, 'DQUEST_PARTSUP', 1); // 일일 미션 '차량·부품 강화 1회' (기록 0 -> 1)
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgUpgradeCarAns',
    body: {
      Seq: 1, Result: R_OK, UpgradeSuccess: true, ResultCarInfo: car, UserInfo: ui,
      RemovedCarInfo: [], RemovedPartsInfo: [], NormalDeltaExp: deltaExp, BonusDeltaExp: 0,
      ...(propChanged ? { PropertySet: snap.PropertySet } : {}),
    },
  }];
});

register('MsgUpgradeInfoReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = (snap?.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(body?.TargetCarInfo?.Carid));
  if (!snap || !car) return [{ name: 'MsgUpgradeInfoAns', body: { Seq: 1, Result: R_FAIL } }];
  const pv = upgradePreview(snap, car, body?.SourceCarInfo ?? []);
  if ('error' in pv) {
    console.warn(`[garage] 강화 조회 거절: ${pv.error}`);
    // 실기록 2026-11-02 (37건): 대상이 이미 최대 레벨이면 {Seq, Result 101} 만 온다
    if (pv.error === '이미 최대 레벨') return [{ name: 'MsgUpgradeInfoAns', body: { Seq: 1, Result: 101 } }];
    return [{ name: 'MsgUpgradeInfoAns', body: { Seq: 1, Result: R_FAIL } }];
  }
  return [{ name: 'MsgUpgradeInfoAns', body: {
    Seq: 1, Result: 1, SuccessChance: 100, ChanceupBonus: { CarLevelBonus: pv.bonus, TotalBonus: pv.bonus },
    Cost: { Coin: pv.cost }, ExpectedCarInfo: { ...car, ...pv.expected },
  } }];
});

register('MsgSetCurrentCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = (snap?.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(body?.CarInfo?.Carid));
  if (!snap || !car) return [{ name: 'MsgSetCurrentCarAns', body: { Seq: 1, Result: R_FAIL } }];
  snap.UserInfo.Currentcar = Number(car.Carid);
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgSetCurrentCarAns', body: { Seq: 1, Result: 1, UserInfo: snap.UserInfo } }];
});
