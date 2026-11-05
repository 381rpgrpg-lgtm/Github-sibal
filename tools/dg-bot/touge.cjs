// Haunted Pass Board: 무료 주사위(State.Tickets)만 1개씩 굴린다. Gold Cash 는 쓰지 않는다 (무료가 0 이면 멈춤).
//   node touge.cjs [최대 횟수]. 결과는 run/samples-touge.jsonl. 고르기(Picks)가 생기면 멈추고 알린다.
const fs = require('fs'); const B = 'http://localhost:8080';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const rpc = async (n, b) => (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || [];
  const max = Number(process.argv[2]) || 1;
  for (let i = 0; i < max; i++) {
    const bd = (await rpc('LocalTougeBoardReq', {})).find((m) => m.name === 'LocalTougeBoardAns')?.body;
    const st = bd?.Board?.State;
    if (!bd || bd.Result !== 1 || !bd.Board.Open) { console.log('board closed', bd?.Result); return; }
    if (st.Picks?.length) { console.log('PICKS pending', JSON.stringify(st.Picks)); return; }
    if (!(Number(st.Tickets) > 0)) { console.log('no free dice; stop (Gold Cash not used)', JSON.stringify(st)); return; }
    const r = (await rpc('LocalTougeRollReq', { Count: 1 })).find((m) => m.name === 'LocalTougeRollAns')?.body;
    const s2 = r?.Board?.State;
    const rec = { at: new Date().toISOString(), before: { pos: st.Pos, laps: st.Laps, rolls: st.Rolls, tickets: st.Tickets }, result: r?.Result,
      steps: r?.Steps, reward: r?.RewardInfo, after: s2 && { pos: s2.Pos, laps: s2.Laps, rolls: s2.Rolls, tickets: s2.Tickets, picks: s2.Picks, moves: s2.Moves }, cash: r?.UserInfo?.Cash, gold: r?.Board?.GoldCash };
    fs.appendFileSync(__dirname + '/run/samples-touge.jsonl', JSON.stringify(rec) + '\n');
    if (i === 0) fs.writeFileSync(__dirname + '/run/touge-roll-first.json', JSON.stringify(r, null, 1));
    console.log(JSON.stringify(rec).slice(0, 700));
    if (r?.Result !== 1) return;
  }
})();
