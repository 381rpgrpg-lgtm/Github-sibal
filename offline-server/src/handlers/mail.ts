// 우편함. 클라이언트 계약(소스 확인):
//  - MsgCheckMailBoxReq {OpenPopup?} -> MsgCheckMailBoxAns {OpenPopup, MailBox, SocialBox}; OpenPopup 이 있어야 창이 열림.
//  - MsgGetMailItemReq {Mail:{MailId}} (한 통) | {Mail:{BoxType}} (탭 전체)
//      -> MsgGetMailItemAns {GetMailStatus:1, MailBox, SocialBox, Items, UserInfo}
//    모든 응답의 MailBox/SocialBox 는 우편함을, Items/UserInfo 는 인벤토리·재화를 교체한다.
import { register, type Msg } from '../rpc.js';
import { grantItem } from '../inventory.js';

const box = (b: any) => ({ Version: b?.Version ?? 1, Mail: b?.Mail ?? [], Count: (b?.Mail ?? []).length });

register('MsgCheckMailBoxReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId) ?? {};
  const ans: any = { Result: 1, MailBox: box(snap.MailBox), SocialBox: box(snap.SocialBox) };
  if (body?.OpenPopup !== undefined) ans.OpenPopup = body.OpenPopup;
  return [{ name: 'MsgCheckMailBoxAns', body: ans }];
});

register('MsgGetMailItemReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgGetMailItemAns', body: { Result: 0, GetMailStatus: 0 } }];
  const want = body?.Mail ?? {};
  const keep: any[] = [];
  let got = 0;
  const deltas: any[] = [];
  for (const m of snap.MailBox?.Mail ?? []) {
    const hit = want.MailId !== undefined ? Number(m.MailId) === Number(want.MailId)
      : want.BoxType !== undefined ? Number(m.BoxType ?? 0) === Number(want.BoxType) : false;
    if (!hit) { keep.push(m); continue; }
    if (m.Itemtype && m.Itemnum) {
      const ok = grantItem(snap, Number(m.Itemtype), Number(m.Itemnum));
      if (ok && ![61001, 61002, 61003].includes(Number(m.Itemtype))) { // 재화(코인·캐시·경험치) 우편은 ItemInfo 에 안 실린다 (실기록 레벨 보상 우편 18건)
        const it = (snap.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === Number(m.Itemtype));
        deltas.push(it ? { Itemid: it.Itemid, Itemtype: Number(m.Itemtype), Count: it.Count, StackNum: it.Count, DeltaNum: Number(m.Itemnum) }
          : { Itemtype: Number(m.Itemtype), Count: Number(m.Itemnum), DeltaNum: Number(m.Itemnum) });
      }
      if (!ok) {
        console.warn(`[mail] 아이템 정의 없음: Itemtype ${m.Itemtype} x${m.Itemnum} (우편은 보관)`);
        keep.push(m);
        continue;
      }
    }
    got++;
  }
  snap.MailBox = { ...box(snap.MailBox), Mail: keep, Count: keep.length };
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgGetMailItemAns',
    body: {
      // 실기록 형식: {Result, UserInfo, MailBox, SocialBox, ItemInfo[{Itemid, Itemtype, Count, StackNum, DeltaNum}], GetMailStatus}
      Result: got > 0 ? 1 : 0,
      UserInfo: snap.UserInfo,
      MailBox: snap.MailBox,
      SocialBox: box(snap.SocialBox),
      ...(deltas.length ? { ItemInfo: deltas } : {}),
      GetMailStatus: got > 0 ? 1 : 0,
    },
  }];
});
