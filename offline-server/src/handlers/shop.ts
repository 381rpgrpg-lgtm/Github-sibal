// 상점 구매: MsgBuyProductReq {StoreItemId, Buycount?, RebornPick?} -> MsgBuyProductAns
// 클라이언트 계약(소스 확인):
//   Result 7 = 캐시 부족, 3 = 코인 부족 (상점 이동 팝업), 8 = 구매 불가(품절/한도) 팝업
//   성공 시 RewardInfo {ItemInfo, CarInfo, UserInfo, ContainerGrade} 로 획득 연출 + 상태 반영(#patch → ApplyReward)
//   ItemInfo 항목은 {Itemid, Itemtype, Count, StackNum, DeltaNum} (StackNum 이 새 수량)
// 데이터: itemTable.json StoreItem/StoreItemGroup/Item, cars.json Car
//
// 오프라인에서 지원: 코인·캐시·소셜포인트·토큰 가격 상품 중 보상이 (코인 61001 | 일반 아이템 | 차량) 인 것.
// 지원하지 않음(기록이 없어 원본과 다르게 동작할 위험): 부품 상자 가챠, 부품, 캐릭터 아이템, 현금 결제 상품
//   -> Result 8 로 거절하고 사유를 로그에 남긴다.
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';
import { grantItem, itemDef } from '../inventory.js';

const R_NO_CASH = 7, R_NO_COIN = 3, R_UNAVAILABLE = 8, R_OK = 1;
const COIN_ITEM = 61001;
const CAT_COIN = 610, CAT_GIRLITEM = 612;
const TABLES = new URL('../../data/tables/', import.meta.url).pathname;

let store: { items: Map<number, any>; groups: Map<number, any[]> } | null = null;
let carDefs: Map<number, any> | null = null;
function load() {
  if (store) return;
  const it = existsSync(TABLES + 'itemTable.json') ? JSON.parse(readFileSync(TABLES + 'itemTable.json', 'utf8')) : {};
  store = { items: new Map(), groups: new Map() };
  for (const s of it.StoreItem ?? []) store.items.set(Number(s.Id), s);
  for (const g of it.StoreItemGroup ?? []) {
    const k = Number(g.ItemGroupId);
    store.groups.set(k, [...(store.groups.get(k) ?? []), g]);
  }
  carDefs = new Map();
  if (existsSync(TABLES + 'cars.json')) for (const c of JSON.parse(readFileSync(TABLES + 'cars.json', 'utf8')).Car ?? []) carDefs.set(Number(c.Id), c);
}

function rewardsOf(si: any): { type: number; amount: number }[] {
  const out: { type: number; amount: number }[] = [];
  if (si.ItemType) out.push({ type: Number(si.ItemType), amount: Number(si.Amount) || 1 });
  if (si.ItemType2) out.push({ type: Number(si.ItemType2), amount: Number(si.Amount2) || 1 });
  for (const g of store!.groups.get(Number(si.ItemGroupId)) ?? []) out.push({ type: Number(g.ItemType), amount: Number(g.Amount) || 1 });
  return out;
}

type Kind = 'coin' | 'item' | 'car' | 'unsupported';
function kindOf(type: number): Kind {
  if (type === COIN_ITEM) return 'coin';
  const def = itemDef(type);
  if (def) return Number(def.Category) === CAT_COIN ? 'coin' : Number(def.Category) === CAT_GIRLITEM ? 'unsupported' : 'item';
  if (carDefs!.has(type)) return 'car';
  return 'unsupported'; // 부품 등
}

// 새 차량 레코드: 계정 스냅샷의 차량 필드 구성을 따르고 값은 cars.json 정의에서.
function newCar(snap: any, cartype: number): any {
  const d = carDefs!.get(cartype);
  const carid = (snap.Cars?.CarInfo ?? []).reduce((m: number, c: any) => Math.max(m, Number(c.Carid) || 0), 0) + 1;
  return {
    Carid: carid, Cartype: cartype, ItemInfo: [], UpgradeLevel: 1, SlotNum: Number(d.SlotInit) || 1, Mastery: 0,
    Price: Number(d.SellPrice) || 0, Attributes: { ...d.Attributes }, MasteryCapacity: Number(d.SoftLimit) || 40,
    MasteryAttr: { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 },
    FuelConsume: 20, FuelConsume20404: 13, NthGeneration: 1, IsExhibited: false,
    ColorTable: d.ColorTable, ColorIndex: Number(d.ColorIndex) || 1, DecalIndex: -1, PlateName: '',
    CoatingSkill: 0, CoatingValue: 0, CoatingCount: 0, CoatingTime: 0, CoatingCoin: 8000,
    Grade: Number(d.Grade) || 1, CarName: '', IsLocked: false, ExpansionLevel: 0, CarExp: 0, DeltaMastery: 0,
  };
}

const fail = (Result: number, StoreItemId: number): Msg[] => [{ name: 'MsgBuyProductAns', body: { Seq: 1, Result, StoreItemId } }];

register('MsgBuyProductReq', (body, ctx): Msg[] => {
  load();
  const id = Number(body?.StoreItemId);
  const si = store!.items.get(id);
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!si || !snap) return fail(R_UNAVAILABLE, id);

  const reason = (why: string) => { console.warn(`[shop] ${id} 구매 거절: ${why}`); return fail(R_UNAVAILABLE, id); };
  if (si.GachaId) return reason('부품 상자 가챠는 오프라인 미지원');
  const price = { Coin: Number(si.PriceCoin) || 0, Cash: Number(si.PriceCash) || 0, SocialPoint: Number(si.PriceSocialPoint) || 0, Token: Number(si.PriceToken) || 0 };
  const free = !price.Coin && !price.Cash && !price.SocialPoint && !price.Token;
  if (free && (si.PriceRealMoney || si.AosProductId || si.IosProductId || si.WSProductId)) return reason('현금 결제 상품');
  const rewards = rewardsOf(si);
  if (!rewards.length) return reason('보상 정의 없음');
  const kinds = rewards.map((r) => kindOf(r.type));
  if (kinds.includes('unsupported')) return reason(`미지원 보상 타입 ${rewards.filter((_, i) => kinds[i] === 'unsupported').map((r) => r.type).join(',')}`);

  // 구매 한도 (BuyGroup 단위)
  const limitKey = `buy:${ctx.session.accountId}:${si.BuyGroup ?? id}`;
  const bought = Number(ctx.store.getMeta(limitKey) ?? 0);
  if (si.BuyLimit && bought >= Number(si.BuyLimit)) return reason('구매 한도 도달');

  // 차고 칸
  const carsNeeded = kinds.filter((k) => k === 'car').length;
  const ui = snap.UserInfo;
  if (carsNeeded && (snap.Cars?.CarInfo?.length ?? 0) + carsNeeded > Number(ui.GarageSize || 0)) return reason('차고 칸 부족');

  // 재화
  if ((Number(ui.Cash) || 0) < price.Cash) return fail(R_NO_CASH, id);
  if ((Number(ui.Coin) || 0) < price.Coin) return fail(R_NO_COIN, id);
  if ((Number(ui.SocialPoint) || 0) < price.SocialPoint) return fail(R_NO_COIN, id);
  if ((Number(ui.Token) || 0) < price.Token) return fail(R_NO_COIN, id);
  ui.Cash -= price.Cash; ui.Coin -= price.Coin; ui.SocialPoint -= price.SocialPoint; ui.Token -= price.Token;

  // 지급
  const itemDeltas: any[] = [];
  const newCars: any[] = [];
  rewards.forEach((r, i) => {
    if (kinds[i] === 'coin') { ui.Coin = (Number(ui.Coin) || 0) + r.amount; return; }
    if (kinds[i] === 'car') { const c = newCar(snap, r.type); snap.Cars.CarInfo.push(c); newCars.push(c); return; }
    grantItem(snap, r.type, r.amount);
    for (const it of snap.Items.ItemInfo.filter((x: any) => Number(x.Itemtype) === r.type)) {
      itemDeltas.push({ ...it, StackNum: it.Count, DeltaNum: r.amount });
    }
  });
  ctx.store.setMeta(limitKey, String(bought + 1));
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgBuyProductAns',
    body: {
      Seq: 1, Result: R_OK, StoreItemId: id, UserInfo: ui,
      RewardInfo: { ItemInfo: itemDeltas, CarInfo: newCars, UserInfo: ui, ContainerGrade: 0 },
      Items: snap.Items, Cars: snap.Cars,
    },
  }];
});
