#!/usr/bin/env bash
# 원본 APK의 서버 URL을 로컬 오프라인 서버로 바꾸고 cleartext(HTTP)를 허용해 재서명한다.
#   repoint-apk.sh <원본.apk> <출력.apk> <서버URL> <keystore> <storepass>
# 예: repoint-apk.sh app.apk app-local.apk http://192.168.0.10:8080 diag.jks pass
# 게임 로직은 바꾸지 않는다. URL 상수 5곳 치환 + usesCleartextTraffic=true 만 적용.
set -euo pipefail
IN=$(realpath "$1"); OUT=$(realpath -m "$2"); URL="$3"; KS=$(realpath "$4"); PASS="$5"
BT="$ANDROID_HOME/build-tools/35.0.0"
case "$URL" in https://*|http://*) ;; *) echo "URL은 http:// 또는 https:// 로 시작해야 함" >&2; exit 1;; esac
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

java -jar "$APKTOOL" d -f -o "$W/dec" "$IN" >/dev/null
OLD='https://game.driftgirlsreborn.com'
CNT=$(grep -rl "$OLD" "$W/dec/smali" | wc -l)
# const-string 치환 (후행 슬래시 변형 보존을 위해 base 만 치환)
grep -rl "$OLD" "$W/dec/smali" | while read -r f; do sed -i "s#${OLD}#${URL}#g" "$f"; done
echo "URL 치환: smali 파일 ${CNT}개"
# cleartext 허용 (http 서버용). https 면 불필요하지만 무해.
sed -i 's#usesCleartextTraffic="false"#usesCleartextTraffic="true"#' "$W/dec/AndroidManifest.xml"
grep -o 'usesCleartextTraffic="[a-z]*"' "$W/dec/AndroidManifest.xml"

java -jar "$APKTOOL" b -o "$W/base.apk" "$W/dec" >/dev/null
"$BT/zipalign" -f -p 4 "$W/base.apk" "$W/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$PASS" --out "$OUT" "$W/aligned.apk"
"$BT/apksigner" verify "$OUT" >/dev/null && echo "서명 검증 OK"
echo "빌드 완료: $OUT  (서버=$URL)"
