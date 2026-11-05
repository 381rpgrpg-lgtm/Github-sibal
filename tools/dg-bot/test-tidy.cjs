// tidyItems 모의 실행: bot.cjs 의 아이템 정리 구간만 떼어 RPC 를 가짜로 바꿔 돌린다 (실계정에 아무것도 보내지 않음).
// node test-tidy.cjs [ITEM_WANT]  — run/ud.json 을 입력으로, 정리 순서와 결과를 출력
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/bot.cjs', 'utf8');
const a = src.indexOf('const ITEM_WANT'), b = src.indexOf('// ── 관리 작업 ──');
let body = src.slice(a, b);
const want = Number(process.argv[2] || 3);
body = body.replace('const ITEM_WANT = 3;', `const ITEM_WANT = ${want};`);
const ud0 = JSON.parse(fs.readFileSync(__dirname + '/run/ud.json', 'utf8'));
let ud = JSON.parse(JSON.stringify(ud0));
const sent = [];
// 가짜 서버: 사용·판매 시 해당 행 수량을 줄인다. 연료는 거절(가득), 상자는 빈 보상
async function rpc(name, req) {
  sent.push(`${name} ${JSON.stringify(req)}`);
  const row = (id) => ud.Items.ItemInfo.find((x) => x.Itemid === id);
  if (name === 'MsgLoginReq') return [{ name: 'MsgUserData', body: JSON.parse(JSON.stringify(ud)) }];
  if (name === 'MsgUseItemReq') {
    const r = row(req.Item.Itemid);
    const fuel = [60042, 60043].includes(r?.Itemtype);
    if (!r || fuel) return [{ name: 'MsgUseItemAns', body: { Result: fuel ? 2 : 0 } }];
    r.StackNum = (r.StackNum ?? r.Count) - 1; r.Count = r.StackNum;
    if (r.StackNum <= 0) ud.Items.ItemInfo = ud.Items.ItemInfo.filter((x) => x !== r);
    return [{ name: 'MsgUseItemAns', body: { Result: 1, RewardInfo: { ItemInfo: [], CarInfo: [] } } }];
  }
  if (name === 'MsgSellPartsReq') {
    for (const id of req.Itemid) ud.Items.ItemInfo = ud.Items.ItemInfo.filter((x) => x.Itemid !== id);
    return [{ name: 'MsgDeleteParts', body: { ItemInfo: req.Itemid.map((id) => ({ Itemid: id, StackNum: 0 })) } }];
  }
  return [];
}
const pick = (m, n) => m.find((x) => x.name === n)?.body;
const log = (s) => console.log('log ', s);
const act = (s) => console.log('ACT ', s);
const f = new Function('fs', 'rpc', 'pick', 'log', 'act', body + '\nreturn { tidyItems, itemTables, itemFreeOf };');
const api = f(fs, rpc, pick, log, act);
(async () => {
  const T = await api.itemTables();
  console.log('before free', api.itemFreeOf(ud, T));
  const out = await api.tidyItems(JSON.parse(JSON.stringify(ud)));
  console.log('after free', api.itemFreeOf(out, T), 'rpc calls', sent.length);
  console.log(sent.filter((s) => !s.startsWith('MsgLoginReq')).join('\n'));
})();
