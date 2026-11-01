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
    g = newGirlRecord(girlid);
    snap.MyGirls.MyGirlInfo.push(g);
    snap.MyGirls.Version = (snap.MyGirls.Version ?? 0) + 1;
  }
  return g;
}

// 신규 캐릭터 레코드. 형식·초기값은 실서버 MsgFirstSelectAns.SelectGirl 기록(2026-11-01) 그대로.
//   NextFamiliarityTime 은 기록상 요청 시점 + 약 13시간. NextCoin 200, GirlItemSlotNum 15.
export function newGirlRecord(girlid: number): any {
  return {
    Girlid: Number(girlid), Familiarity: 400, Emotion: 0, ItemFlag: 0, NthDate: 0, State: GIRL_OPEN,
    Rarity: girlDef(girlid)?.Rarity ?? 1, DateCoolTime: 0, DateCoolTimeResetCost: 1, LastDatePlace: 0,
    SameDateCnt: 0, DatingState: [], GirlItemSlotNum: 15, NextCoin: 200,
    NextFamiliarityTime: Math.floor(Date.now() / 1000) + 13 * 3600,
  };
}

// Ggraph(관계도)에서 해당 캐릭터 노드를 열고(State 7) 맨 앞으로 옮긴 뒤 NodeId 를 1.. 로 다시 매긴다.
function openGraphNode(snap: any, girlid: number) {
  const nodes: any[] = snap.Ggraph?.Gnode ?? [];
  const i = nodes.findIndex((n) => Number(n.GirlInfo?.Girlid) === Number(girlid));
  if (i < 0) return;
  const [node] = nodes.splice(i, 1);
  node.State = GIRL_OPEN;
  nodes.unshift(node);
  nodes.forEach((n, k) => (n.NodeId = k + 1));
}

const TUTORIAL_FIRST_SELECT = 256; // UserInfo.Completion 비트 (실서버: 109 -> 365)

// 튜토리얼 첫 선택: {SelectGirl:{Girlid}} -> MsgFirstSelectAns {Seq, UserInfo, Ggraph, SelectGirl, GirlItemInfo}
// 클라이언트는 응답을 기다리지 않고 SELECT_<id> 스크립트로 진행하며, Completion 비트로 튜토리얼 단계를 판단한다.
register('MsgFirstSelectReq', (body, ctx): Msg[] => {
  const girlid = Number(body?.SelectGirl?.Girlid);
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap || !girlDef(girlid)) return [{ name: 'MsgFirstSelectAns', body: { Result: 1 } }];
  const g = ensureGirl(snap, girlid);
  Object.assign(g, { ...newGirlRecord(girlid), ...g, State: GIRL_OPEN });
  openGraphNode(snap, girlid);
  const ui = snap.UserInfo;
  ui.FirstGirl = girlid;
  ui.MainGirl = girlid;
  ui.PassengerGirl = girlid;
  ui.Completion = (Number(ui.Completion) || 0) | TUTORIAL_FIRST_SELECT;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgFirstSelectAns',
    body: { Seq: 1, UserInfo: ui, Ggraph: snap.Ggraph, SelectGirl: g, GirlItemInfo: [] },
  }];
});
