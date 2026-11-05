// 사용자 승인된 1회성 캐시 사용 (2026-11-06): FM 부스트 20208(지아), 퀘스트 10805 목표 68 즉시 완료. 안전 관문 경유, 응답 전부 기록
const S = require('./safety.cjs'); S.init(__dirname + '/run', (s) => console.log(s));
const fs = require('fs'); const B = 'http://localhost:8080';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const out = [];
  const rpc = async (n, b) => { const c = await S.beforeSend(n, b); if (!c.ok) { console.log('BLOCKED', n, c.reason); return []; } const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || []; S.onResponse(n, b, m); out.push({ n, b, m }); return m; };
  const show = (ms) => ms.forEach((x) => { const v = { ...x.body }; if (v.UserInfo) v.UserInfo = { Cash: v.UserInfo.Cash, Coin: v.UserInfo.Coin }; if (v.GirlInfo) v.GirlInfo = { Girlid: v.GirlInfo.Girlid, Familiarity: v.GirlInfo.Familiarity, NthDate: v.GirlInfo.NthDate, Emotion: v.GirlInfo.Emotion }; console.log('  ', x.name, JSON.stringify(v).slice(0, 700)); });
  const ud = (await rpc('MsgLoginReq', {})).find((m) => m.name === 'MsgUserData').body;
  console.log('cash before', ud.UserInfo.Cash);
  console.log('FMBoostInfo 20208'); const info = (await rpc('MsgFMBoostInfoReq', { GirlInfo: { Girlid: 20208 } })); show(info);
  const ia = info.find((m) => m.name === 'MsgFMBoostInfoAns')?.body;
  if (ia?.Result === 1 && Number(ia.NeedCash) <= 50) { console.log('FMBoost 20208'); show(await rpc('MsgFMBoostReq', { GirlInfo: { Girlid: 20208 } })); }
  else console.log('skip FM boost', JSON.stringify(ia).slice(0, 200));
  const q = (ud.NquestInfos?.NquestInfo ?? []).find((x) => x.QuestId === 10805 && x.State === 3);
  const o = q?.Objective?.find((x) => x.ObjId === 68);
  if (o && !o.CashCleared && Number(o.CompleteCash) === 75) { console.log('ObjectiveClear 10805/68'); show(await rpc('MsgNquestObjectiveClearReq', { QuestId: 10805, ObjId: 68 })); }
  else console.log('skip 10805', JSON.stringify(o));
  fs.writeFileSync(__dirname + '/run/cash-oneoff.json', JSON.stringify(out, null, 1));
})();
