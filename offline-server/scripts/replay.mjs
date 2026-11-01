// 녹화 재생 비교: 녹화 시작 시점의 실계정 상태(MsgLoginReq 의 MsgUserData)를 로컬 DB 에 넣고, 녹화된 요청을 같은 순서로
// 로컬 서버에 보내 응답을 필드 단위로 비교한다. 서버를 먼저 띄운 뒤 실행.
// 사용: node scripts/replay.mjs <data/recorded 폴더> <data/state.db> <시작 ts> [끝 ts] [--only=MsgA,MsgB] [--verbose]
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [dir, dbPath, fromTs, toTs='9999999999999'] = process.argv.slice(2);
const only = (process.argv.find(a=>a.startsWith('--only='))||'').slice(7).split(',').filter(Boolean);
const verbose = process.argv.includes('--verbose');
const B='http://localhost:8080';
const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>({f,ts:+f.split('_')[1]}))
  .filter(x=>x.ts>=+fromTs && x.ts<=+toTs).sort((a,b)=>a.ts-b.ts);
const recs = files.map(x=>({...JSON.parse(fs.readFileSync(dir+'/'+x.f,'utf8')), file:x.f}));
const login = recs.find(r=>r.name==='MsgLoginReq');
const ud = login.response.messages.find(m=>m.name==='MsgUserData').body;
const build=(await (await fetch(B+'/api/version')).json()).build;
const lr=await (await fetch(B+'/api/login',{method:'POST',headers:{'content-type':'application/json','x-dg-build':build},body:JSON.stringify({login:'damissi',password:'x'})})).json();
const H={authorization:'Bearer '+lr.token,'x-dg-build':build,'content-type':'application/json'};
const rpc=async(name,body)=>{const j=await (await fetch(B+'/api/rpc',{method:'POST',headers:H,body:JSON.stringify({name,body})})).json(); return j.messages||[{name:'ERROR',body:j}]};
await rpc('MsgLoginReq',{});
const db=new DatabaseSync(dbPath);
const row=db.prepare('select account_id from users').get();
db.prepare('update users set snapshot=? where account_id=?').run(JSON.stringify(ud), row.account_id);
db.prepare("delete from meta where key like 'date:%' or key like 'battle:%'").run();
db.close();
const IGN=new Set(['Seq','time','Fueltime','DateCoolTime','NextFamiliarityTime','ExpireTime','ReplaySeed','Tvalue','EventRaceNextRefreshTime','DailyRewardTime','Charname']);
function diff(a,b,path,out){
  if(out.length>40) return;
  if(a===b) return;
  if(typeof a==='number'&&typeof b==='number'&&Math.abs(a-b)<1e-6) return;
  if(a&&b&&typeof a==='object'&&typeof b==='object'){
    if(Array.isArray(a)!==Array.isArray(b)){out.push(`${path}: type`);return;}
    if(Array.isArray(a)){ if(a.length!==b.length) out.push(`${path}: len mine ${a.length} rec ${b.length}`); for(let i=0;i<Math.min(a.length,b.length);i++) diff(a[i],b[i],`${path}[${i}]`,out); return;}
    for(const k of new Set([...Object.keys(a),...Object.keys(b)])){ if(IGN.has(k)) continue;
      if(!(k in a)) out.push(`${path}.${k}: missing (rec=${JSON.stringify(b[k]).slice(0,80)})`);
      else if(!(k in b)) out.push(`${path}.${k}: extra (mine=${JSON.stringify(a[k]).slice(0,80)})`);
      else diff(a[k],b[k],`${path}.${k}`,out);}
    return;}
  out.push(`${path}: mine=${JSON.stringify(a)?.slice(0,80)} rec=${JSON.stringify(b)?.slice(0,80)}`);
}
let total=0, clean=0;
for(const r of recs){
  if(r.name==='MsgLoginReq') continue;
  if(only.length && !only.includes(r.name)) { await rpc(r.name, r.request); continue; }
  const mine=await rpc(r.name, r.request);
  const rec=r.response.messages||[];
  const out=[];
  const mn=mine.map(m=>m.name).filter(n=>n!=='MsgNotifyEvent'&&n!=='MsgUpdateNquest'&&n!=='MsgUpdateData').join(','), rn=rec.map(m=>m.name).filter(n=>n!=='MsgNotifyEvent'&&n!=='MsgUpdateNquest'&&n!=='MsgUpdateData').join(',');
  if(mn!==rn) out.push(`messages: mine ${mn} rec ${rn}`);
  for(const m of rec){ const x=mine.find(y=>y.name===m.name); if(x) diff(x.body,m.body,m.name,out); }
  total++; if(!out.length) clean++;
  console.log(`${out.length?'✗':'✓'} ${r.file.split('_')[0]} ${r.name} ${JSON.stringify(r.request).slice(0,70)}`);
  if(out.length) for(const o of out.slice(0, verbose?40:8)) console.log('    '+o);
}
console.log(`\n${clean}/${total} 일치`);
