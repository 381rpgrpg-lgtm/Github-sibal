// 보관함 정리 도구 (실서버 RPC, 결과는 run/cleanup.log)
//   node inv.cjs status                      아이템·부품 빈 칸과 부품 목록
//   node inv.cjs equip <Itemid> <Carid> <Idx> 부품 장착 (MsgEquipPartsReq)
//   node inv.cjs combine <Target> <Mat,...>  부품 조합 (MsgCombinePartsReq)
//   node inv.cjs use <Itemtype>              아이템 1개 사용 (MsgUseItemReq)
const fs = require('fs');
const B = 'http://localhost:8080';
const LOG = __dirname + '/run/cleanup.log';
const T = '/home/user/Github-sibal/offline-server/data/tables/';
const log = (s) => { const l = `[${new Date().toISOString().slice(5, 19)}] ${s}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
const P = JSON.parse(fs.readFileSync(T + 'parts.json', 'utf8')).Part;
const CARS = JSON.parse(fs.readFileSync(T + 'cars.json', 'utf8')).Car;
(async () => {
  const { readTable } = await import('/home/user/Github-sibal/offline-server/dist/upserts.js');
  const IT = readTable(T + 'itemTable.json', 'itemTable.json').Item;
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const rpc = async (n, b = {}) => (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || [];
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  const ud = (await rpc('MsgLoginReq')).find((x) => x.name === 'MsgUserData')?.body;
  const ui = ud.UserInfo, items = ud.Items.ItemInfo;
  const part = (t) => P.find((p) => p.Id === Number(t));
  const isDecal = (t) => { const d = IT.find((i) => i.Id === Number(t)); return !!d && d.Category >= 621 && d.Category <= 625; };
  const status = (u, it) => {
    const counted = it.filter((x) => !part(x.Itemtype) && !isDecal(x.Itemtype));
    const free = it.filter((x) => part(x.Itemtype) && !(x.Equipcarid > 0));
    return { itemFree: u.ItemSlotNum - counted.length, partsFree: u.PartsSlotNum - free.length };
  };
  if (cmd === 'status') {
    const s = status(ui, items);
    console.log(`itemFree ${s.itemFree} partsFree ${s.partsFree} coin ${ui.Coin} cash ${ui.Cash} fuel ${ui.Fuelvalue} FightTicket ${ui.FightTicket}`);
    for (const c of ud.Cars.CarInfo) console.log(`car ${c.Carid} ${c.Cartype} ★${CARS.find((x) => x.Id === c.Cartype)?.Grade} lv${c.UpgradeLevel} slots ${c.SlotNum}: ` +
      items.filter((x) => x.Equipcarid === c.Carid).map((x) => `[${x.Equipindex}] ${x.Itemid}:${x.Itemtype}★${part(x.Itemtype)?.Grade} L${x.ItemLevel}/${x.ItemExp}`).join(' '));
    for (const x of items.filter((x) => part(x.Itemtype) && !(x.Equipcarid > 0))) console.log(`  free part ${x.Itemid}:${x.Itemtype} ★${part(x.Itemtype).Grade} cat${part(x.Itemtype).Category} ${JSON.stringify(x.Attributes)}`);
    return;
  }
  let m, name;
  if (cmd === 'equip') { name = 'MsgChangeParts'; m = await rpc('MsgEquipPartsReq', { Itemid: Number(a1), Equipindex: Number(a3), Equipcarid: Number(a2) }); }
  else if (cmd === 'combine') { name = 'MsgCombinePartsAns'; m = await rpc('MsgCombinePartsReq', { Itemid: Number(a1), ConsumeParts: String(a2).split(',').map(Number) }); }
  else if (cmd === 'use') { name = 'MsgUseItemAns'; const row = items.find((x) => x.Itemtype === Number(a1)); if (!row) return log(`use ${a1}: none`); m = await rpc('MsgUseItemReq', { Item: { Itemid: row.Itemid } }); }
  else return console.log('unknown cmd');
  const a = m.find((x) => x.name === name)?.body;
  const brief = JSON.stringify({ ...a, UserInfo: undefined, CarInfo: a?.CarInfo ? '…' : undefined }).slice(0, 700);
  log(`${cmd} ${process.argv.slice(3).join(' ')}: Result ${a?.Result} ${brief} others ${m.filter((x) => x.name !== name).map((x) => x.name).join(',')}`);
  const ud2 = (await rpc('MsgLoginReq')).find((x) => x.name === 'MsgUserData')?.body;
  const s = status(ud2.UserInfo, ud2.Items.ItemInfo);
  log(`  -> itemFree ${s.itemFree} partsFree ${s.partsFree} coin ${ud2.UserInfo.Coin}`);
})();
