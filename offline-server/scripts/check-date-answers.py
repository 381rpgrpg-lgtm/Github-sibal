# 사용: python3 scripts/check-date-answers.py [고칠 값 json 출력 경로]  (src/data 는 저장소 밖 게임 데이터)
# 데이트 선택지 표(src/data/date-answers.json) 를 실기록 반응(ActionResult 3 좋아함 / 1 싫어함)과 대조
import json, glob, collections, sys
R = '/home/user/Github-sibal/offline-server/data/recorded/'
T = json.load(open('/home/user/Github-sibal/offline-server/src/data/date-answers.json'))
liked = T['liked']
files = sorted(glob.glob(R + '*.json'), key=lambda x: int(x.split('/')[-1].split('_')[1]))
cur = None; obs = collections.defaultdict(set)
for f in files:
    n = f.split('/')[-1]
    if '_MsgDateStartReq' in n:
        d = json.load(open(f)); girl = (d['request'].get('GirlInfo') or {}).get('Girlid'); script = lv = None
        for m in d['response'].get('messages', []):
            for ch in (m['body'].get('Script') or {}).get('Chunk') or []:
                s = ch.get('ScriptName') or ''
                if s.startswith('Date_') and not any(s.startswith(p) for p in ('Date_Event', 'Date_End', 'Date_Boring', 'Date_Start', 'Date_Peevish', 'Date_Preference')) and script is None:
                    script, lv = s, ch.get('FamiliarityLv')
        cur = (girl, script, lv); continue
    if '_MsgScriptProgressReq' not in n or not cur or not cur[1]: continue
    d = json.load(open(f)); q = d['request']
    if q.get('Depth') != 0 or 'AnswerSelect' not in q or q.get('Index') not in (1, 2): continue
    a = [m['body'] for m in d['response'].get('messages', []) if m['name'] == 'MsgScriptProgressAns']
    ar = a[0].get('ActionResult') if a else None
    if ar not in (1, 3): continue
    ans = q['AnswerSelect']; real = ans if ar == 3 else (2 if ans == 1 else 1)
    obs[f'{cur[0]}|{cur[1]}|{cur[2]}|{q["Index"]}'].add(real)
ok = bad = new = conflict = 0; fixes = {}
for k, v in obs.items():
    if len(v) > 1: conflict += 1; continue
    r = next(iter(v))
    if k not in liked: new += 1; fixes[k] = r
    elif liked[k] == r: ok += 1
    else: bad += 1; fixes[k] = r; print('WRONG', k, 'table', liked[k], 'real', r)
print(f'observed keys {len(obs)}: ok {ok}, wrong {bad}, missing {new}, conflicting {conflict}')
if len(sys.argv) > 1: json.dump(fixes, open(sys.argv[1], 'w'), indent=0); print('fixes ->', sys.argv[1])
