// 이벤트 레이스 데이터 만들기: data/recorded 의 실서버 기록(새로고침·시작·결과·보상 수령·LocalReborn)에서
// src/data/event-races.json (구역별 제목·이벤트 Id·순위 보상표, 레이스별 Chapter·RivalScale·Track·첫 승 보상·실제 경험치·상대 차량)을 만든다.
// 사용: node scripts/make-event-races.cjs   (게임 데이터라 저장소에는 넣지 않는다: .gitignore data/)
const fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..'),D=path.join(ROOT,'data/recorded'),OUT=path.join(ROOT,'src/data/event-races.json');
// 기록에서 이벤트 구역 레이스 정보·첫 승 우편·누적 보상 우편을 모은다

const fl=fs.readdirSync(D).sort((a,b)=>a.split('_')[1]-b.split('_')[1]);
const racesRaw={}, mails=[], tickets=[], zonesMeta={};
const put=(r)=>{ if(!(r.ZoneId>=1000))return; const k=r.RaceId; const o=racesRaw[k]??={}; for(const f of ['RaceId','PosId','ZoneId','RaceLifeType','RaceMode','RaceIndex','RewardCoin','RewardXP','Track','RivalScale','Chapter','TimeLimit']) if(r[f]!==undefined) o[f]=r[f]; (o.wp??=new Set()).add(r.WinPoint); (o.states??=new Set()).add(r.State); };
for(const f of fl){ if(!/Refresh|RaceReward|BattleStart|BattleResult/.test(f))continue; const r=JSON.parse(fs.readFileSync(D+'/'+f));
  for(const m of r.response?.messages??[]){ const b=m.body;
    for(const z of b.UpdateData?.RaceZone??b.RaceZone??[]){ if(z.ZoneId>=1000){ if(z.Race)for(const x of z.Race)put(x); for(const x of z.ChangeRace??[])put(x); for(const x of z.NewRace??[])put(x);
        if(z.Name){const {Race,...rest}=z; zonesMeta[z.ZoneId]={...rest};} } }
    if(b.Race)put(b.Race);
    if(m.name==='MsgNotifyEvent'&&b.MailBox) for(const x of b.MailBox.Mail) mails.push({f:f.split('_')[1],req:r.request,...x});
    if(b.UserInfo&&/Battle/.test(f)) tickets.push([f.replace(/^\d+_/,'').slice(0,40),b.UserInfo.EventRaceTicket,b.UserInfo.Fuelvalue]);
  }}

// 기록 -> src/data/event-races.json (이벤트 구역별 제목, 레이스별 Reborn 확장 정보·첫 승 보상·실제 경험치)

const races=Object.fromEntries(Object.entries(racesRaw).map(([k,o])=>[k,{...o,wp:[...o.wp],states:[...o.states]}]));

const out={};
const zoneOf=(z)=>out[z]??={title:null,kitModel:null,races:{}};
for(const r of Object.values(races)){ const z=zoneOf(r.ZoneId); const e=z.races[r.RaceIndex]={};
  for(const k of ['RewardCoin','RewardXP','RaceMode','TimeLimit','Track','RivalScale','Chapter']) if(r[k]!==undefined) e[k]=r[k]; }
const seen=new Set();
// 처음 기록된 상대 차량 (생성 시점): 차종·표시 등급·능력치 합
for(const f of fl){ if(!/Refresh|RaceReward/.test(f))continue; const rec=JSON.parse(fs.readFileSync(D+'/'+f));
  for(const m of rec.response.messages) for(const z of m.body.UpdateData?.RaceZone??m.body.RaceZone??[]) for(const x of [...(z.Race??[]),...(z.NewRace??[])]){
    if(!(x.ZoneId>=1000))continue; const e=zoneOf(x.ZoneId).races[x.RaceIndex]; if(!e||e.opp)continue; const o=x.OpponentCarInfo;
    const STD=new Set(['Carid','Cartype','ItemInfo','UpgradeLevel','SlotNum','Mastery','Price','Attributes','MasteryCapacity','MasteryAttr','FuelConsume','FuelConsume20404','NthGeneration','IsExhibited','ColorTable','ColorIndex','DecalIndex','PlateName','CoatingSkill','CoatingValue','CoatingCount','CoatingTime','CoatingCoin','Grade','CarName','IsLocked','ExpansionLevel','CarExp']);
    const extra=Object.fromEntries(Object.entries(o).filter(([k])=>!STD.has(k)));
    e.opp={Cartype:o.Cartype,Grade:o.Grade,sum:Object.values(o.Attributes).reduce((a,b)=>a+b,0),...(Object.keys(extra).length?{extra}:{})}; } }
for(const f of fl){ if(!/MsgRaceRewardReq|MsgBattleResultReq/.test(f))continue; const rec=JSON.parse(fs.readFileSync(D+'/'+f)); const b=rec.response.messages[0].body; const zid=rec.request.ZoneId; if(!(zid>=1000))continue;
  const z=zoneOf(zid);
  if(/Result/.test(f)&&b.IsPlayerWin){ const idx=b.Race.RaceIndex; (z.races[idx].xp??=b.DeltaInfo.Charexp); }
  if(/RaceReward/.test(f)&&b.RebornGot){ z.title=b.RebornGot.Title; z.kitModel=b.RebornGot.KitModel; const idx=b.Race.RaceIndex; const ch=z.races[idx].Chapter?.Title;
    z.races[idx].firstWin=b.RebornGot.Mails.filter(m=>ch&&m.Subject===`${z.title}: ${ch}`).map(m=>[m.Itemtype,m.Itemnum]); }
}
// LocalReborn 상태·보상표 (이벤트 Id, 시즌 시작, 순위 보상표)
for(const f of fl){ if(!/LocalReborn/.test(f))continue; const rec=JSON.parse(fs.readFileSync(D+'/'+f)); const b=rec.response.messages[0]?.body; if(!b)continue;
  for(const e of b.Events??[]){ const z=zoneOf(e.Zone-50000); z.reborn??={}; z.reborn.Id=e.Id; z.reborn.SeasonStart=e.Season?.Start; z.title??=e.Title; }
  if(b.Rewards){ const z=zoneOf(b.Rewards.Zone-50000); z.reborn??={}; z.reborn.Id=b.Rewards.Id; z.reborn.Ranking=b.Rewards.Ranking; z.reborn.Static={Rivals:b.Rewards.Rivals,Pool:b.Rewards.Pool,LevelRewards:b.Rewards.LevelRewards,FirstWins:b.Rewards.FirstWins}; } }
out[3311].title ??= 'Give Me a Break!'; // 이벤트 카드 화면 표기 (2026-11-03 캡처). 기록된 보상 응답은 없음
fs.writeFileSync(OUT, JSON.stringify(out,null,1));
for(const [z,v] of Object.entries(out)) console.log(z,v.title,v.kitModel,Object.entries(v.races).map(([i,e])=>i+":xp"+(e.xp??'-')+":fw"+JSON.stringify(e.firstWin??null)).join(' '));
