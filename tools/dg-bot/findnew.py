# 이벤트 지도 스크린샷에서 'NEW' 표식(노란 글자 3개, 폭 45px 이상) 위치를 찾아 노드 중심(표식 아래 30px)을 출력
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); W, H = im.size; px = im.load()
pts = [(x, y) for y in range(230, 700, 2) for x in range(400, W, 2)
       if (lambda r, g, b: r > 220 and 140 < g < 230 and b < 110)(*px[x, y])]
# 행 단위 군집: 가까운 점끼리 묶기
clusters = []
for x, y in pts:
    for c in clusters:
        if abs(c['cx'] - x) < 60 and abs(c['cy'] - y) < 20:
            c['xs'].append(x); c['ys'].append(y); c['cx'] = sum(c['xs']) / len(c['xs']); c['cy'] = sum(c['ys']) / len(c['ys']); break
    else:
        clusters.append({'xs': [x], 'ys': [y], 'cx': x, 'cy': y})
best = [c for c in clusters if max(c['xs']) - min(c['xs']) >= 45 and len(c['xs']) > 25]
best.sort(key=lambda c: -len(c['xs']))
if best:
    c = best[0]; print(int((min(c['xs']) + max(c['xs'])) / 2), int(max(c['ys']) + 30))
else:
    print('none')
