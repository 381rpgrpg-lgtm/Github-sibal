// 아이템 1개 사용: node use-item.cjs <Itemtype> [횟수]  (MsgUseItemReq {Item:{Itemid}}). 결과를 run/cleanup.log 에 남긴다.
// Result 1 이 아니면 즉시 멈춘다. 보상(RewardInfo)과 바뀐 아이템 행을 요약해 출력한다.
const fs = require('fs');
const B = 'http://localhost:8080';
const LOG = __dirname + '/run/cleanup.log';
const log = (s) => { const l = `[${new Date().toISOString().slice(5, 19)}] ${s}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
(async () => {
  const type = Number(process.argv[2]); const times = Number(process.argv[3] || 1);
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const rpc = async (n, b = {}) => (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || [];
  const ud = (await rpc('MsgLoginReq')).find((x) => x.name === 'MsgUserData')?.body;
  const row = (ud?.Items?.ItemInfo ?? []).find((x) => Number(x.Itemtype) === type);
  if (!row) { log(`use ${type}: not in inventory`); return; }
  for (let i = 0; i < times; i++) {
    const m = await rpc('MsgUseItemReq', { Item: { Itemid: row.Itemid } });
    const a = m.find((x) => x.name === 'MsgUseItemAns')?.body;
    const r = a?.RewardInfo ?? {};
    const gain = [r.Coin && `coin ${r.Coin}`, r.Cash && `cash ${r.Cash}`, (r.ItemInfo ?? []).length && `items ${JSON.stringify(r.ItemInfo.map((x) => [x.Itemtype, x.Count ?? x.DeltaNum ?? x.StackNum]))}`,
      (r.CarInfo ?? []).length && `cars ${JSON.stringify(r.CarInfo.map((c) => [c.Carid, c.Cartype]))}`].filter(Boolean).join(' ');
    log(`use ${type} (Itemid ${row.Itemid}) #${i + 1}: Result ${a?.Result} left ${JSON.stringify((a?.ItemInfo ?? []).map((x) => x.StackNum))} FightTicket ${a?.UserInfo?.FightTicket} Fuel ${a?.UserInfo?.Fuelvalue} ${gain} others ${m.filter((x) => x.name !== 'MsgUseItemAns').map((x) => x.name).join(',')}`);
    if (a?.Result !== 1) break;
  }
})();
