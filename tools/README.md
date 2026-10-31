# APK 도구

## repoint-apk.sh — 클라이언트를 로컬 오프라인 서버로 연결
원본 APK의 서버 URL을 로컬 서버로 바꾸고 cleartext(HTTP)를 허용해 재서명한다. 게임 로직은 변경하지 않는다(URL 상수 치환 + manifest cleartext 플래그만).

```
ANDROID_HOME=<sdk> APKTOOL=<apktool_2.12.1.jar> \
  ./tools/repoint-apk.sh <원본.apk> <출력.apk> http://<PC_LAN_IP>:8080 <keystore.jks> <storepass>
```
- `<PC_LAN_IP>`: 오프라인 서버를 돌리는 PC의 LAN IP(예 192.168.0.10). 폰과 같은 Wi-Fi.
- https 서버면 `https://...` 도 가능(cleartext 불필요하지만 무해).

## 연결 절차
1. PC에서 `offline-server` 실행: `npm run build && npm start` (8080).
2. `node scripts/fetch-client.mjs` 로 웹 클라이언트를 `data/client/` 에 받는다(최초 1회).
3. 위 스크립트로 APK 재지정 → 폰에 설치(기존 앱 삭제 후, 서명 키가 다름).
4. 폰과 PC가 같은 네트워크인지 확인 후 앱 실행.

## 알려진 제한
- 메인 화면 렌더링에는 에셋(암호화 팩)이 필요. `data/assets/` 에 복호화본을 둬야 한다.
- 실시간 WebSocket(`/api/pvp`)은 아직 미구현 → 실시간 레이스/PvP는 동작 안 함. 부트~메인·메뉴는 HTTP RPC로 동작.
- 서명 키가 원본과 달라 기존 설치본 위에 덮어쓸 수 없다(삭제 후 설치). 서버 내 자동업데이트도 서명 불일치로 비활성.
