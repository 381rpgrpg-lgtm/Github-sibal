// 로그인 후 MsgUserData 전체를 run/ud.json 으로 저장 (조회 전용)
const B = 'http://localhost:8080';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: 'MsgLoginReq', body: {} }) })).json()).messages || [];
  const ud = m.find((x) => x.name === 'MsgUserData')?.body;
  require('fs').writeFileSync(__dirname + '/run/ud.json', JSON.stringify(ud, null, 1));
  console.log('saved', Object.keys(ud || {}).join(','));
})();
