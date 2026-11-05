// node peek-girl.cjs <girlId> : 로그인해서 그 히로인 상태(삐침 필드 포함)를 출력
const B = 'http://localhost:8080';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const ms = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: 'MsgLoginReq', body: {} }) })).json()).messages;
  const ud = ms.find((m) => m.name === 'MsgUserData').body;
  for (const id of process.argv.slice(2).map(Number)) { const g = ud.MyGirls.MyGirlInfo.find((x) => x.Girlid === id); const { DatingState, ...rest } = g; console.log(JSON.stringify(rest)); }
  console.log('cash', ud.UserInfo.Cash, 'coin', ud.UserInfo.Coin, 'passenger', ud.UserInfo.PassengerGirl);
})();
