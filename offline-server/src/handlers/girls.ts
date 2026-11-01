// 캐릭터(걸) 관련. 데이터 모델은 클라이언트 소스에서 읽은 필드 기준:
//   MyGirls.MyGirlInfo[]: { Girlid, State(7=열림), Familiarity, Rarity, DateCoolTime, ... }
//   UserInfo.PassengerGirl: 동승 캐릭터, UserInfo.FirstGirl: 튜토리얼 첫 선택 캐릭터
// 정의: data/tables/girlTable.json (Girl[].Id / Rarity)
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';

const GIRL_OPEN = 7;
const TABLE = new URL('../../data/tables/girlTable.json', import.meta.url).pathname;
let girlDefs: Map<number, any> | null = null;
function girlDef(id: number) {
  if (!girlDefs) {
    girlDefs = new Map();
    if (existsSync(TABLE)) for (const g of JSON.parse(readFileSync(TABLE, 'utf8')).Girl ?? []) girlDefs.set(Number(g.Id), g);
  }
  return girlDefs.get(Number(id)) ?? null;
}

export function ensureGirl(snap: any, girlid: number): any {
  snap.MyGirls ??= { MyGirlInfo: [], Version: 1 };
  snap.MyGirls.MyGirlInfo ??= [];
  let g = snap.MyGirls.MyGirlInfo.find((x: any) => Number(x.Girlid) === Number(girlid));
  if (!g) {
    g = { Girlid: Number(girlid), State: GIRL_OPEN, Familiarity: 0, Rarity: girlDef(girlid)?.Rarity ?? 1, DateCoolTime: 0 };
    snap.MyGirls.MyGirlInfo.push(g);
    snap.MyGirls.Version = (snap.MyGirls.Version ?? 0) + 1;
  }
  return g;
}

// 튜토리얼 첫 선택: {SelectGirl:{Girlid}}. 클라이언트는 응답을 기다리지 않고 SELECT_<id> 스크립트로 진행한다.
register('MsgFirstSelectReq', (body, ctx): Msg[] => {
  const girlid = Number(body?.SelectGirl?.Girlid);
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap || !girlDef(girlid)) return [{ name: 'MsgFirstSelectAns', body: { Result: 1 } }];
  ensureGirl(snap, girlid);
  snap.UserInfo.FirstGirl = girlid;
  snap.UserInfo.PassengerGirl = girlid;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgFirstSelectAns', body: { Result: 0, UserInfo: snap.UserInfo, MyGirls: snap.MyGirls } }];
});
