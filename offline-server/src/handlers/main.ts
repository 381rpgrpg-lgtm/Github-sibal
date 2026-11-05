// 메인 허브에서 주기적으로 호출되는 메시지. 오프라인에서는 특별 메시지·결제 연출이 없다.
// 응답 형식은 클라이언트 구독부에서 확인: 각 Ans 의 배열 필드가 없거나 비면 아무것도 표시하지 않는다.
import { register, type Msg } from '../rpc.js';
import { table } from '../gamecalc.js';
import { grantItem } from '../inventory.js';
import { streetCheck, streetView, streetSeen } from '../street.js';

// 특별 메시지(운영 공지성 팝업) 목록 — 없음.
register('MsgSpecialMessageListReq', (): Msg[] => [
  { name: 'MsgSpecialMessageListAns', body: { Result: 1, SpecialMessages: [] } },
]);
register('MsgSpecialMessageSeenReq', (): Msg[] => [{ name: 'MsgSpecialMessageSeenAns', body: { Result: 1 } }]);

// 결제 보상 연출 — 오프라인에는 결제가 없다.
register('MsgPurchaseRevealReq', (): Msg[] => [
  { name: 'MsgPurchaseRevealAns', body: { Result: 1, PurchaseReveal: [] } },
]);
register('MsgPurchaseRevealSeenReq', (): Msg[] => [{ name: 'MsgPurchaseRevealSeenAns', body: { Result: 1 } }]);

// 거리 이름 목록 MsgStreetNamesReq -> {Seq, Result 1, Open true, Name, Public, Suggest {P,C,E}, Earned [단어 id, 획득 순], New [안 본 것], Facts}
//   (실기록 21건). 단어 판정·통계는 street.ts. 레이스 밖에서 바뀌는 통계(업적·앨범·월드 투어 등)로 만족한 단어도 여기서 획득 -> New (추정).
//   클라이언트 StreetNamesClient: 첫 확인 때 New 를 공개 팝업 대기열에 넣고, 닫으면 MsgStreetNameSeenReq {Ids}.
register('MsgStreetNamesReq', (_b, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgStreetNamesAns', body: { Seq: 1, Result: 2, Open: false } }];
  streetCheck(snap);
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgStreetNamesAns', body: { Seq: 1, Result: 1, ...streetView(snap) } }];
});

// 거리 이름 '확인함' {Ids} -> {Seq, Result 1} (실기록 8건). 이후 MsgStreetNamesAns.New 에서 빠진다 (실기록 0489 -> 0556).
register('MsgStreetNameSeenReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (snap) { streetSeen(snap, body?.Ids); ctx.store.putUser(ctx.session.accountId, snap); }
  return [{ name: 'MsgStreetNameSeenAns', body: { Seq: 1, Result: 1 } }];
});

// Reborn 가챠 진열 (실기록 고정값: 79610 상자, 대표 차량 3종)
register('MsgRebornGachaShowcaseReq', (): Msg[] => [{ name: 'MsgRebornGachaShowcaseAns', body: {
  Result: 1, Open: true, BoxId: 79610, Cars: [14005, 12004, 11105], Source: 'default' } }]);

// 기억(앨범) 보상 수령: 요청한 기억들의 girlMemoryTable Rewarditem x Rewardvalue 지급, RewardState 2(수령 가능) -> 1(수령 완료).
//   실기록: 20105 기억 10개 -> 코인 2250 (표 합계와 일치), 응답 {GirlMemorySet, UserInfo, ItemInfo[{Itemtype, Count, DeltaNum}]}
register('MsgGetGirlMemoryRewardReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgGetGirlMemoryRewardAns', body: { Result: 2 } }];
  const defs: any[] = table('girlMemoryTable.json')?.GirlMemory ?? [];
  const sums = new Map<number, number>();
  for (const req of body?.GirlMemorySet?.GirlMemory ?? []) {
    const mine = (snap.GirlMemorySet?.GirlMemory ?? []).find((x: any) => Number(x.Girlid) === Number(req.Girlid));
    for (const r of req.Memory ?? []) {
      const m = mine?.Memory?.find((x: any) => Number(x.Id) === Number(r.Id));
      if (!m || Number(m.RewardState) !== 2) continue;
      const d = defs.find((x: any) => Number(x.GirlId) === Number(req.Girlid) && Number(x.Id) === Number(r.Id));
      m.RewardState = 1;
      if (d?.Rewarditem && d?.Rewardvalue) sums.set(Number(d.Rewarditem), (sums.get(Number(d.Rewarditem)) ?? 0) + Number(d.Rewardvalue));
    }
  }
  const items: any[] = [];
  for (const [t, n] of sums) if (grantItem(snap, t, n)) items.push({ Itemtype: t, Count: n, DeltaNum: n });
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgGetGirlMemoryRewardAns', body: { GirlMemorySet: snap.GirlMemorySet, UserInfo: snap.UserInfo, ItemInfo: items } }];
});

// 업적 보상 수령. 실기록(2026-11-02, 업적 12개): State 2 -> 3, RewardIndex x RewardValue 지급 (BonusIndex/BonusValue 는 주지 않음:
//   코인 합 1100 = Reward 합과 일치). 응답 {UserInfo, MyMemorySet{수령한 레코드}, ItemInfo}:
//   ItemInfo 는 아이템을 요청 순서로 {Itemid, Itemtype, Count, StackNum, DeltaNum}, 그 뒤 코인(61001)·캐시(61002) 합계 {Itemtype, Count, DeltaNum}.
register('MsgGetMemoryRewardReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgGetMemoryRewardAns', body: { Result: 2 } }];
  const defs = new Map(((table('achievementTable.json')?.Achievements ?? []) as any[]).map((a) => [Number(a.Index), a]));
  const mine: any[] = snap.MyMemorySet?.Memory ?? [];
  const claimed: any[] = [], items: any[] = [];
  const cur = new Map<number, number>();
  for (const r of body?.MyMemorySet?.Memory ?? []) {
    const m = mine.find((x) => Number(x.Id) === Number(r.Id));
    const d = defs.get(Number(r.Id));
    if (!m || !d || Number(m.State) !== 2) continue;
    m.State = 3;
    claimed.push(m);
    const t = Number(d.RewardIndex), n = Number(d.RewardValue) || 0;
    if (!t || !n || !grantItem(snap, t, n)) continue;
    if (t === 61001 || t === 61002) { cur.set(t, (cur.get(t) ?? 0) + n); continue; }
    const it = (snap.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === t);
    items.push(it ? { Itemid: it.Itemid, Itemtype: t, Count: n, StackNum: it.Count, DeltaNum: n } : { Itemtype: t, Count: n, DeltaNum: n });
  }
  for (const t of [61001, 61002]) if (cur.get(t)) items.push({ Itemtype: t, Count: cur.get(t), DeltaNum: cur.get(t) });
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgGetMemoryRewardAns', body: { Seq: 1, UserInfo: snap.UserInfo, MyMemorySet: { Memory: claimed }, ItemInfo: items } }];
});
