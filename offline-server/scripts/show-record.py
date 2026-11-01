# show.py <dir> <fromTs> seq[,seq...] [maxlen]  — 새 세션 녹화의 요청/응답 출력(큰 필드 축약)
import json,glob,sys
d,fr,seqs=sys.argv[1],int(sys.argv[2]),sys.argv[3].split(',')
mx=int(sys.argv[4]) if len(sys.argv)>4 else 2500
BIG={'OpponentCarInfo','Track','RaceAction','UpdateGirlInfo','Passenger','GirlMemorySet','Memoryset'}
def strip(o,top=True):
    if isinstance(o,dict): return {k:('<..>' if k in BIG else ({kk:o[k][kk] for kk in ('Charlevel','Charexp','Coin','Cash','SocialPoint','Completion','LevelUp','Fuelvalue') if kk in o[k]} if k=='UserInfo' else strip(v,False))) for k,v in o.items()}
    if isinstance(o,list): return [strip(x,False) for x in o]
    return o
fs=[f for f in glob.glob(d+'/*.json') if int(f.split('/')[-1].split('_')[1])>=fr]
for s in seqs:
    for f in fs:
        if f.split('/')[-1].startswith(s.zfill(4)+'_'):
            j=json.load(open(f)); print('=====',f.split('/')[-1]); print('REQ',json.dumps(j['request'],ensure_ascii=False)[:600])
            for m in j['response'].get('messages',[]): print('  ',m['name'],json.dumps(strip(m['body']),ensure_ascii=False)[:mx])
