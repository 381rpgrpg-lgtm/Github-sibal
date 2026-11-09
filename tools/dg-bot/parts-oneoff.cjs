const DGP = require('./paths.cjs');
// 1회성 부품 강화 (2026-11-08). 사용자: "봇의 진전이 너무 막힌다 싶으면 얻는 캐시의 양을 고려해서 과하지 않게 적절히 사용. 봇 말고 네 판단으로만"
//   13-14 (상대 40.19~40.21, 최고 40.35) 는 가속(Acc) 이 기록을 가장 많이 바꾼다 (설정 시험 7건: Acc 589 -> 759 에 약 -0.15 초).
//   부품은 강화하면 레벨당 기본 능력치의 약 15% 씩 오른다 (오프라인 서버 실측 Lv2 1건, 그 위는 추정 -> 이 스크립트가 실제 값을 남긴다).
//   패배 화면 팁(lose_tip7): "시험용 파츠를 강화 재료로 쓰면 경험치를 더 많이" -> 시험용 파츠 MixExp ★4 2194 / ★5 3656 (일반 ★4 368).
// 단계 (인수): plan = 로그인해서 계획만 출력 / free = 남는 부품으로 강화 / buy = 프리미엄 파츠 박스 72005(20 캐시) 1개 + 시험용 파츠 투입
// 안전: 모든 요청은 safety.cjs 를 지난다. 예외 둘만 이 스크립트가 직접 검사한다
//   - ★4 재료: ALLOW4 에 적은 번호+종류가 그대로이고, 장착·잠금이 아닐 때만 (같은 종류 중복·하위 대체품)
//   - 72005 구매: 상점 표에 Gold Cash·실결제 가격이 없고 PriceCash 20 인지, 캐시가 400 이상 남는지, 구매 뒤 감소가 정확히 20 인지
const S = require('./safety.cjs'); S.init(__dirname + '/run', (s) => console.log(s));
const fs = require('fs'); const B = 'http://localhost:8080';
const T = (DGP.srv('data/tables') + '/');
const PT = new Map(JSON.parse(fs.readFileSync(T + 'parts.json', 'utf8')).Part.map((p) => [p.Id, p]));
const TARGET = { Itemid: 266, Itemtype: 37302 };                      // 차량 10 의 BH챔피언쉽 엔진 ★4 (MaxSpd 62, Acc 62)
const ALLOW4 = { 185: 32341, 270: 32312, 264: 36312, 268: 34341, 258: 33301 }; // 남는 ★4: 같은 분류에 같거나 나은 부품이 따로 있음
const BY_CAT = { 1: 249, 2: 266, 6: 253 };                            // 시험용 파츠를 넣을 Acc 부품 (분류가 같으면 경험치 100%)
const mode = process.argv[2] || 'plan';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const out = [];
  const send = async (n, b) => { const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || []; S.onResponse(n, b, m); out.push({ at: new Date().toISOString(), n, b, m }); return m; };
  const rpc = async (n, b, skipGuard) => { if (!skipGuard) { const c = await S.beforeSend(n, b); if (!c.ok) { console.log('BLOCKED', n, c.reason); return []; } } return send(n, b); };
  const save = () => fs.writeFileSync(__dirname + `/run/parts-oneoff-${mode}.json`, JSON.stringify(out, null, 1));
  const login = async () => (await rpc('MsgLoginReq', {})).find((m) => m.name === 'MsgUserData').body;
  const A = (a) => ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'].map((k) => Number(a?.[k]) || 0);
  const desc = (it) => `${it.Itemid}:${it.Itemtype}(★${PT.get(it.Itemtype)?.Grade} c${PT.get(it.Itemtype)?.Category} L${it.ItemLevel ?? 1}) [${A(it.Attributes)}]`;
  let ud = await login();
  const parts = () => (ud.Items?.ItemInfo ?? []).filter((i) => PT.has(i.Itemtype));
  const tgt = () => parts().find((i) => i.Itemid === TARGET.Itemid && i.Itemtype === TARGET.Itemtype);
  console.log('cash', ud.UserInfo.Cash, 'coin', ud.UserInfo.Coin, 'target', tgt() ? desc(tgt()) : 'MISSING');
  if (!tgt()) { save(); return; }
  const free = (i) => !(i.Equipcarid > 0) && !i.IsLocked && i.Itemid !== TARGET.Itemid;
  const g = (i) => PT.get(i.Itemtype)?.Grade ?? 9, c = (i) => PT.get(i.Itemtype)?.Category;
  const tc = c(tgt());
  const mats3 = parts().filter((i) => free(i) && g(i) <= 3);
  const mats4 = parts().filter((i) => free(i) && g(i) === 4 && ALLOW4[i.Itemid] === i.Itemtype);
  const order = [...mats3.filter((i) => c(i) === tc), ...mats4.filter((i) => c(i) === tc), ...mats3.filter((i) => c(i) !== tc), ...mats4.filter((i) => c(i) !== tc)];
  console.log('materials', order.length, order.map(desc).join(' | '));
  if (mode === 'free') {
    for (let k = 0; k < order.length; k += 3) {
      const batch = order.slice(k, k + 3);
      const before = tgt();
      const m = await rpc('MsgCombinePartsReq', { Itemid: TARGET.Itemid, ConsumeParts: batch.map((i) => i.Itemid) }, batch.some((i) => g(i) === 4));
      const a = m.find((x) => x.name === 'MsgCombinePartsAns')?.body;
      console.log(`combine ${batch.map((i) => i.Itemid)} -> Result ${a?.Result} L${a?.Upgraded?.PrevItemLevel}/${a?.Upgraded?.PrevItemExp} -> L${a?.Upgraded?.ItemLevel}/${a?.Upgraded?.ItemExp} attr [${A(a?.Upgraded?.Attributes)}] coin ${a?.UserInfo?.Coin}`);
      if (a?.Result !== 1) { console.log('stop: combine failed', JSON.stringify(a).slice(0, 300)); break; }
      ud = await login(); if (!tgt()) { console.log('stop: target gone'); break; }
      if ((tgt().ItemLevel ?? 1) < (before.ItemLevel ?? 1)) { console.log('stop: level went down'); break; }
    }
    console.log('after', desc(tgt()));
  }
  if (mode === 'buy') {
    const { readTable } = await import(DGP.url('dist/upserts.js'));
    const si = readTable(T + 'itemTable.json', 'itemTable.json').StoreItem.find((s) => s.Id === 72005);
    const bad = !si || Number(si.PriceCash) !== 20 || ['PriceGoldCash', 'PriceRealMoney', 'PriceRealMoneyInt', 'PriceRealMoneyJP', 'PriceCoin'].some((k) => si[k] !== undefined);
    const cash0 = Number(ud.UserInfo.Cash);
    if (bad || cash0 - 20 < 400) { console.log('stop: store row or cash check failed', JSON.stringify(si), cash0); save(); return; }
    const m = await rpc('MsgBuyProductReq', { StoreItemId: 72005, Buycount: 1 }, true);
    const a = m.find((x) => x.name === 'MsgBuyProductAns')?.body;
    const cash1 = Number(a?.UserInfo?.Cash ?? NaN);
    console.log(`buy 72005 -> Result ${a?.Result} cash ${cash0} -> ${cash1} parts ${(a?.RewardInfo?.ItemInfo ?? []).map(desc).join(' | ')} pity ${JSON.stringify({ g: a?.GachaPity, p: a?.PartsPity, hq: a?.PartsPityHq, cap: a?.RewardInfo?.PartsCap })}`);
    if (a?.Result !== 1 || cash0 - cash1 !== 20) { console.log('stop: unexpected purchase result'); save(); return; }
    ud = await login();
    const got = (a.RewardInfo?.ItemInfo ?? []).map((x) => parts().find((i) => i.Itemid === x.Itemid && i.Itemtype === x.Itemtype)).filter(Boolean);
    const trial = got.filter((i) => /시험용|_31$|31$/.test(String(PT.get(i.Itemtype)?.Name)) || String(i.Itemtype).slice(3) === '31');
    for (const it of got) {
      const isTrial = String(it.Itemtype).slice(3) === '31';   // 시험용 파츠 = 종류 번호 끝 두 자리 31 (31331, 32431 ...)
      if (!isTrial && g(it) >= 4) { console.log('keep', desc(it)); continue; }
      const to = BY_CAT[c(it)] ?? TARGET.Itemid;
      const dest = parts().find((i) => i.Itemid === to);
      if (!dest) { console.log('no dest for', desc(it)); continue; }
      const m2 = await rpc('MsgCombinePartsReq', { Itemid: to, ConsumeParts: [it.Itemid] }, g(it) >= 4);
      const b2 = m2.find((x) => x.name === 'MsgCombinePartsAns')?.body;
      console.log(`feed ${desc(it)} -> ${desc(dest)}: Result ${b2?.Result} -> L${b2?.Upgraded?.ItemLevel}/${b2?.Upgraded?.ItemExp} attr [${A(b2?.Upgraded?.Attributes)}]`);
      ud = await login();
    }
    console.log('trial parts', trial.length);
  }
  save();
})();
