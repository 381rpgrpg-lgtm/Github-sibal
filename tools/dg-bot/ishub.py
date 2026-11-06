# 메인 화면(허브) 판정: 오른쪽 아래 'Race'(995~1070, 683~710)·'Challenge'(1110~1275, 683~710) 흰 글씨 픽셀 수
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
def white(x0, y0, x1, y1):
    return sum(1 for x in range(x0, x1) for y in range(y0, y1) if min(im.getpixel((x, y))) > 225)
r, c = white(995, 683, 1070, 710), white(1110, 683, 1275, 710)
print(int(650 <= r <= 800 and 1400 <= c <= 1650), r, c)  # 허브 고정 UI 실측 725/1515 (큰 흰 팝업·경주 화면 오탐 제외)
