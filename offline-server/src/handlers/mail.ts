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
  const ans: any = { Result: 0, MailBox: box(snap.MailBox), SocialBox: box(snap.SocialBox) };
  if (body?.OpenPopup !== undefined) ans.OpenPopup = body.OpenPopup;
  return [{ name: 'MsgCheckMailBoxAns', body: ans }];
});

register('MsgGetMailItemReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgGetMailItemAns', body: { Result: 1, GetMailStatus: 0 } }];
  const want = body?.Mail ?? {};
  const keep: any[] = [];
  let got = 0;
  for (const m of snap.MailBox?.Mail ?? []) {
    const hit = want.MailId !== undefined ? Number(m.MailId) === Number(want.MailId)
      : want.BoxType !== undefined ? Number(m.BoxType ?? 0) === Number(want.BoxType) : false;
    if (!hit) { keep.push(m); continue; }
    if (m.Itemtype && m.Itemnum) {
      if (!grantItem(snap, Number(m.Itemtype), Number(m.Itemnum))) {
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
      Result: 0,
      GetMailStatus: got > 0 ? 1 : 0,
      MailBox: snap.MailBox,
      SocialBox: box(snap.SocialBox),
      Items: snap.Items,
      UserInfo: snap.UserInfo,
    },
  }];
});
