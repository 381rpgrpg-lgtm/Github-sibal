// 데이트 1회 (RPC, 중계 서버 경유). node dates.cjs <girlId> <placeId>
// 흐름(실기록 2026-11-01~02): Propose -> Start(장소) -> 서버가 준 대본의 Index 표지를 차례로 진행.
//   SEL_END Index n(문항) = {Depth 0, Index n, AnswerSelect 좋아하는 답}, 표지만 있는 Index n = {Depth 0, Index n},
//   중간 사건(Index 5, 채팅·선물) = {Depth 1, Index 5[, AnswerSelect]} 을 다음 차례로 끼워 넣는다.
const fs = require('fs');
const B = 'http://localhost:8080';
const liked = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/src/data/date-answers.json', 'utf8')).liked;
// 실제 반응으로 배운 답 (run/date-learned.json): 표는 반응 대사 비교 추정이라 틀린 칸이 있다 (2026-11-05: 20303 Date_Restaurant lv2 두 문항 -> 화남).
//   싫어함(ActionResult 1)이면 다른 답을, 좋아함(3)이면 그 답을 기록하고 표보다 먼저 쓴다
const LEARN = __dirname + '/run/date-learned.json';
const learned = (() => { try { return JSON.parse(fs.readFileSync(LEARN, 'utf8')); } catch { return {}; } })();
// 백화점 데이트: node dates.cjs <girlId> 0 <선물 플래그> — 장소 없이 Start {GirlInfo:{Girlid}} (클라이언트 OnClickDept),
//   대본의 SHOPLIST 단계에 {Depth, Index, AnswerSelect: 플래그 합} (클라이언트 ShopList -> #progress). 플래그: 0 구경, 1·2·4·8 액세서리, 64 수영복
//   (girlTable PresentPrice1..5, 수영복은 친밀도 3 이상 + 액세서리 4개(ItemFlag&15==15) 뒤에 열림. 수영복 = 한계 돌파 공통 조건 3 '수영복 선물')
const [girl, place, present] = process.argv.slice(2).map(Number);
let H;
async function rpc(name, body = {}) {
  if (!H) { const build = (await (await fetch(B + '/api/version')).json()).build;
    const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
    H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' }; }
  return (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name, body }) })).json()).messages || [];
}
const pick = (ms, n) => ms.find((m) => m.name === n)?.body;
function markers(ms, ctx) {
  const out = [];
  for (const m of ms) for (const ch of m.body?.Script?.Chunk ?? []) {
    if (ch.ScriptName && ch.FamiliarityLv !== undefined && /^Date_/.test(ch.ScriptName) && !/^Date_(Event|End|Boring|Start)/.test(ch.ScriptName)) { ctx.script = ch.ScriptName; ctx.lv = ch.FamiliarityLv; }
    // GIFT(퀘스트 아이템 등)는 사건 단계(Depth 1)로 데이트가 끝나기 전에 보낸다
    //   (기록: 10603 공학 서적 {Depth 1, Index 5} -> GiftFromGirl 63005. 10701 실험 자료를 {Depth 0, Index 3} 로 종료 뒤에 보냈을 때는 받지 못함)
    for (const i of ch.Instruction ?? []) if (i.Index !== undefined) out.push({ index: i.Index, depth: i.Depth ?? (i.Function === 'GIFT' || i.Index >= 5 ? 1 : 0), sel: i.Function === 'SEL_END' || i.Function === 'QUESTION', shop: i.Function === 'SHOPLIST', fn: i.Function });
  }
  return out;
}
(async () => {
  const ud = pick(await rpc('MsgLoginReq'), 'MsgUserData');
  const g = ud.MyGirls.MyGirlInfo.find((x) => x.Girlid === girl);
  if (!g || g.State !== 7) { console.log('girl not open'); return; }
  const coinBefore = ud.UserInfo.Coin, famBefore = g.Familiarity;
  const p = pick(await rpc('MsgDateProposeReq', { GirlInfo: g }), 'MsgDateProposeAns');
  if (p?.Result !== 1) { console.log('propose fail', JSON.stringify(p).slice(0, 200)); return; }
  const sm = await rpc('MsgDateStartReq', place ? { GirlInfo: { Girlid: girl }, DatePlace: place } : { GirlInfo: { Girlid: girl } });
  if (!place) fs.writeFileSync(__dirname + '/run/dept-start.json', JSON.stringify(sm, null, 1));
  const s = pick(sm, 'MsgDateStartAns');
  if (s?.Result !== 1) { console.log('start fail', JSON.stringify(s).slice(0, 300)); await rpc('MsgDateStopReq', {}); return; }
  const ctx = {}; let queue = markers(sm, ctx); const done = new Set(); let result = null, n = 0;
  while (queue.length && n++ < 12) {
    const mk = queue.shift(); const key = `${mk.depth}:${mk.index}`; if (done.has(key)) continue; done.add(key);
    const body = { Depth: mk.depth, Index: mk.index };
    // DG_BAD=1: 삐침 실험용 — 좋아하는 답이 아닌 답을 고른다 (문항: 좋아하는 답이 1이면 2, 아니면 1 / 사건 문항: 2)
    const BAD = process.env.DG_BAD === '1';
    const akey = `${girl}|${ctx.script}|${ctx.lv}|${mk.index}`;
    if (mk.sel) { const lk = learned[akey] ?? liked[akey] ?? 1; body.AnswerSelect = mk.depth === 0 ? (BAD ? (lk === 1 ? 2 : 1) : lk) : (BAD ? 2 : 1); }
    if (mk.shop) body.AnswerSelect = Number(present) || 0;
    const ms = await rpc('MsgScriptProgressReq', body);
    if (!place) fs.appendFileSync(__dirname + '/run/dept-progress.jsonl', JSON.stringify({ body, fn: mk.fn, ms }) + '\n');
    const a = pick(ms, 'MsgScriptProgressAns');
    if (mk.sel && mk.depth === 0 && !BAD && (a?.ActionResult === 1 || a?.ActionResult === 3)) {
      const real = a.ActionResult === 3 ? body.AnswerSelect : (body.AnswerSelect === 1 ? 2 : 1);
      if ((learned[akey] ?? liked[akey] ?? 1) !== real) { learned[akey] = real; fs.writeFileSync(LEARN, JSON.stringify(learned)); console.log(`  learned ${akey} -> ${real}`); }
    }
    if (a?.DateReward) result = a.DateReward;
    const fin = pick(ms, 'MsgDateResultAns'); if (fin) result = { ...(result ?? {}), final: fin.DateResult };
    const nw = markers(ms, ctx).filter((x) => !done.has(`${x.depth}:${x.index}`));
    const ev = nw.filter((x) => x.depth === 1), rest = nw.filter((x) => x.depth !== 1);
    queue = [...ev, ...queue, ...rest];
    console.log(`  ${JSON.stringify(body)} -> ${JSON.stringify({ act: a?.ActionResult, res: a?.Result, reward: a?.DateReward?.DateResult })}`);
  }
  const u2 = pick(await rpc('MsgLoginReq'), 'MsgUserData'); const g2 = u2.MyGirls.MyGirlInfo.find((x) => x.Girlid === girl);
  console.log(JSON.stringify({ girl, place, script: ctx.script, lv: ctx.lv, result, fam: `${famBefore}->${g2.Familiarity}`, coin: `${coinBefore}->${u2.UserInfo.Coin}`,
    dq: (u2.PropertySet?.Property ?? []).filter((x) => /DQUEST/.test(x.PropertyName)).map((x) => x.PropertyName + '=' + x.Nvalue).join(' ') }));
})();
