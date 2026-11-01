// 상점 구매: MsgBuyProductReq {StoreItemId, Buycount?, RebornPick?} -> MsgBuyProductAns
// 클라이언트 계약(소스 확인):
//   Result 7 = 캐시 부족, 3 = 코인 부족 (상점 이동 팝업), 8 = 구매 불가(품절/한도) 팝업
//   성공 시 RewardInfo {ItemInfo, CarInfo, UserInfo, ContainerGrade} 로 획득 연출 + 상태 반영(#patch → ApplyReward)
//   ItemInfo 항목은 {Itemid, Itemtype, Count, StackNum, DeltaNum} (StackNum 이 새 수량)
// 데이터: itemTable.json StoreItem/StoreItemGroup/Item, cars.json Car
//
// 오프라인에서 지원: 코인·캐시·소셜포인트·토큰 가격 상품 중 보상이 (코인 61001 | 일반 아이템 | 차량) 인 것,
//   부품 상자 가챠(content.boxOdds 에 maxPartGrade 가 있는 상자).
// 지원하지 않음(기록이 없어 원본과 다르게 동작할 위험): 차량 가챠, 부품 단품, 캐릭터 아이템, 현금 결제 상품
//   -> Result 8 로 거절하고 사유를 로그에 남긴다.
//
// 부품 상자 (실서버 기록 2026-11-01, 72005 프리미엄 부품 상자 4회):
//   Buycount 1 = PriceCash(20), Buycount 2 = '다시 구매' SalePrice(16). 어느 쪽이든 상자당 boxOdds.items(2)개.
//   RewardInfo {Coin0,Charexp0,Cash0,Familiartity0, ItemInfo[부품], CarInfo[], ContainerGrade 0, PartsCap}
//   부품 = {Itemid, Itemtype, Count 1, Equipcarid 0, Equipindex 0, Attributes(parts.json 정의), ItemLevel 1, ItemExp 0, Category}
//   Cost {Cash, Coin 0, SocialPoint 0, Token 0, GoldCash 0}, Buycount, GachaPity/PartsPity/PartsPityHq(계정 값 그대로)
//   capToBestCar: 보유 차량 최고 등급(=PartsCap, 기록 1)으로 byCap 확률표를 고른다. 기록에서는 전부 Grade 1 부품.
// 추정(기록 없음): 확률 등급(common/rare/epic/legendary/ultra) -> 부품 Grade 1..5 대응, 같은 등급 안에서 균등 추첨.
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';
import { grantItem, itemDef } from '../inventory.js';
import { newOwnedCar } from '../gamecalc.js';

const R_NO_CASH = 7, R_NO_COIN = 3, R_UNAVAILABLE = 8, R_OK = 1;
const COIN_ITEM = 61001;
const CAT_COIN = 610, CAT_GIRLITEM = 612;
const TABLES = new URL('../../data/tables/', import.meta.url).pathname;

let store: { items: Map<number, any>; groups: Map<number, any[]> } | null = null;
let partDefs: any[] | null = null;
let boxOdds: any = null;
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
  partDefs = existsSync(TABLES + 'parts.json') ? (JSON.parse(readFileSync(TABLES + 'parts.json', 'utf8')).Part ?? []) : [];
  const content = new URL('../../data/content.json', import.meta.url).pathname;
  boxOdds = existsSync(content) ? JSON.parse(readFileSync(content, 'utf8')).boxOdds ?? null : null;
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

const TIERS = ['common', 'rare', 'epic', 'legendary', 'ultra'];
const PART_CATS = new Set([1, 2, 3, 4, 5, 6]);

function partsBox(si: any, box: any, body: any, snap: any, ctx: any): Msg[] {
  const id = Number(si.Id);
  const ui = snap.UserInfo;
  const buycount = Number(body?.Buycount) || 1;
  const cost = buycount > 1 && si.SalePrice !== undefined ? Number(si.SalePrice) : Number(si.PriceCash) || 0;
  if ((Number(ui.Cash) || 0) < cost) return fail(R_NO_CASH, id);
  const parts = (snap.Items?.ItemInfo ?? []).filter((x: any) => PART_CATS.has(Number(x.Category)));
  if (parts.length + (Number(si.PartSlotNeed) || 0) > Number(ui.PartsSlotNum || 0)) {
    console.warn(`[shop] ${id} 구매 거절: 부품 칸 부족 (${parts.length}/${ui.PartsSlotNum})`);
    return fail(R_UNAVAILABLE, id);
  }
  const bestCar = (snap.Cars?.CarInfo ?? []).reduce((m: number, c: any) => Math.max(m, Number(c.Grade) || 1), 1);
  const cap = box.capped ? Math.min(bestCar, 5) : 5;
  const odds = (box.capped && box.byCap?.[String(cap)]) || box.tiers;
  ui.Cash -= cost;
  const got: any[] = [];
  for (let n = 0; n < (Number(box.items) || 1); n++) {
    let r = Math.random(), tier = 0;
    for (let i = 0; i < TIERS.length; i++) { r -= Number(odds[TIERS[i]]) || 0; if (r < 0) { tier = i; break; } }
    const grade = Math.min(tier + 1, Number(box.maxPartGrade) || 6);
    const pool = partDefs!.filter((p) => Number(p.Grade) === grade && Number(p.Distribute) === 1);
    const def = pool[Math.floor(Math.random() * pool.length)];
    if (!def) continue;
    const itemid = (snap.Items.ItemInfo ?? []).reduce((m: number, it: any) => Math.max(m, Number(it.Itemid) || 0), 0) + 1;
    const part = {
      Itemid: itemid, Itemtype: Number(def.Id), Count: 1, Equipcarid: 0, Equipindex: 0,
      Attributes: { ...def.Attributes }, ItemLevel: 1, ItemExp: 0, Category: Number(def.Category),
    };
    snap.Items.ItemInfo.push(part);
    got.push(part);
  }
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgBuyProductAns',
    body: {
      Seq: 1, Result: R_OK, StoreItemId: id, UserInfo: ui,
      RewardInfo: { Coin: 0, Charexp: 0, Cash: 0, Familiartity: 0, ItemInfo: got, CarInfo: [], ContainerGrade: 0, PartsCap: cap },
      Cost: { Cash: cost, Coin: 0, SocialPoint: 0, Token: 0, GoldCash: 0 }, Buycount: buycount,
      GachaPity: snap.GachaPity, PartsPity: snap.PartsPity, PartsPityHq: snap.PartsPityHq,
    },
  }];
}

// 차량 상자 (실기록: 71026 무료 일일 상자 -> 10501 BEEMER 1, 73008 코인 상자 6900 -> 10501·10201).
//   응답 {Result, StoreItemId, UserInfo, RewardInfo{.., CarInfo[새 차량], ContainerGrade 1}, Cost, Buycount, GachaPity, PartsPity, PartsPityHq}
//   무료 상자: UserData.OnedayFreeShop [{StoreItemId}] 에 있고 ExipreTime 이 없거나 지났으면 무료, 사용 후 ExipreTime = +24h (실기록 형식)
// 추정: 확률 등급(common..ultra) -> 차량 ★1..5, 그 등급에서 Distribute>0 차량 균등 추첨.
function carBox(si: any, box: any, body: any, snap: any, ctx: any): Msg[] {
  const id = Number(si.Id);
  const ui = snap.UserInfo;
  if ((snap.Cars?.CarInfo?.length ?? 0) >= Number(ui.GarageSize || 6)) {
    console.warn(`[shop] ${id} 구매 거절: 차고 칸 부족`); return fail(R_UNAVAILABLE, id);
  }
  const nowS = Math.floor(Date.now() / 1000);
  const free = (snap.OnedayFreeShop ?? []).find((x: any) => Number(x.StoreItemId) === id && !(Number(x.ExipreTime) > nowS));
  const price = free ? { Cash: 0, Coin: 0, SocialPoint: 0 } : { Cash: Number(si.PriceCash) || 0, Coin: Number(si.PriceCoin) || 0, SocialPoint: Number(si.PriceSocialPoint) || 0 };
  if ((Number(ui.Cash) || 0) < price.Cash) return fail(R_NO_CASH, id);
  if ((Number(ui.Coin) || 0) < price.Coin || (Number(ui.SocialPoint) || 0) < price.SocialPoint) return fail(R_NO_COIN, id);
  ui.Cash -= price.Cash; ui.Coin -= price.Coin; ui.SocialPoint = (Number(ui.SocialPoint) || 0) - price.SocialPoint;
  let r = Math.random(), tier = 0;
  for (let i = 0; i < TIERS.length; i++) { r -= Number(box.tiers?.[TIERS[i]]) || 0; if (r < 0) { tier = i; break; } }
  const pool = [...carDefs!.values()].filter((c: any) => Number(c.Grade) === tier + 1 && Number(c.Distribute) > 0);
  const def = pool[Math.floor(Math.random() * pool.length)] ?? carDefs!.get(10101);
  const car = newOwnedCar(snap, Number(def.Id));
  snap.Cars.CarInfo.push(car);
  if (free) free.ExipreTime = nowS + 86400;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgBuyProductAns',
    body: {
      Seq: 1, Result: R_OK, StoreItemId: id, UserInfo: ui,
      RewardInfo: { Coin: 0, Charexp: 0, Cash: 0, Familiartity: 0, ItemInfo: [], CarInfo: [car], ContainerGrade: 1 },
      Cost: { Cash: price.Cash, Coin: price.Coin, SocialPoint: price.SocialPoint, Token: 0, GoldCash: 0 }, Buycount: Number(body?.Buycount) || 1,
      GachaPity: snap.GachaPity, PartsPity: snap.PartsPity, PartsPityHq: snap.PartsPityHq,
      ...(snap.OnedayFreeShop ? { OnedayFreeShop: snap.OnedayFreeShop } : {}),
    },
  }];
}

const fail = (Result: number, StoreItemId: number): Msg[] => [{ name: 'MsgBuyProductAns', body: { Seq: 1, Result, StoreItemId } }];

register('MsgBuyProductReq', (body, ctx): Msg[] => {
  load();
  const id = Number(body?.StoreItemId);
  const si = store!.items.get(id);
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!si || !snap) return fail(R_UNAVAILABLE, id);

  const reason = (why: string) => { console.warn(`[shop] ${id} 구매 거절: ${why}`); return fail(R_UNAVAILABLE, id); };
  if (si.GachaId) {
    const box = boxOdds?.boxes?.[String(id)];
    if (!box) return reason('상자 확률표 없음');
    if (!Number(box.maxPartGrade)) return carBox(si, box, body, snap, ctx);
    return partsBox(si, box, body, snap, ctx);
  }
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
