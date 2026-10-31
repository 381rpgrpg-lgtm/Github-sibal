# Drift Girls Reborn — 오프라인화 / 서버-클라이언트 분리 설계

분석 환경에서 소유·위탁제작하신 클라이언트 소스(난독화 해제)와 당신 계정(`damissi`) 세션으로 확인한 사실에 근거합니다. 서버 `game.driftgirlsreborn.com`, 서버 라벨 `0.80 REBORN`, content 버전 `2026-10-23.3+3ceb2de6c9ee` (확인 2026-10-31).

## 1. 구조 요약 (정정 반영)

제공 빌드는 "얇은 클라이언트 + 권위 서버" 구조입니다. 클라이언트는 렌더링·입력·연출만 하고, **상태와 규칙은 서버가 쥡니다.**

- 부트: 앱(WebView) → `game.driftgirlsreborn.com/` 로드 → 클라이언트 번들(three.js r170, WebGL2) 실행
- 인증: `POST /api/login {login,password}` → `token`, `sigKey`, `assetBase`, `packs`(버전), `content`(버전)
- 이후 모든 인증 요청에 서명 3종 헤더: `x-dg-build`, `x-dg-c`(마이크로초 카운터 nonce), `x-dg-s`(HMAC-SHA256)
- 실시간 게임플레이: `/api/pvp`를 `ws(s)`로 전환한 WebSocket. `hello`→`welcome` 핸드셰이크 후 `MsgXxxReq/Ans/Not` 메시지 교환
- 단발 요청: `POST /api/rpc {name, body}`

## 2. REST 엔드포인트 (13개)

| 경로 | 용도 |
|---|---|
| `POST /api/login` | 로그인, 토큰·서명키 발급 |
| `POST /api/register` | 계정 생성 |
| `POST /api/logout` | 로그아웃 |
| `POST /api/password` | 비밀번호 변경 |
| `GET /api/content` | 게임 데이터 테이블·텍스트 (평문 JSON) |
| `GET /api/scripts` | 스토리 대사 (평문 JSON) |
| `GET /api/packs` | 에셋 팩 매니페스트 |
| `POST /api/keys` | 팩 복호화 키 (**암호화된 에셋의 DRM 키**) |
| `POST /api/rpc` | 단발 명령 |
| `GET /api/session` | 세션 확인 |
| `POST /api/report` | 오류 보고 |
| `POST /api/photo` | 사진/스냅 업로드 |
| `(ws) /api/pvp` | 실시간 메시지 채널 |

## 3. 서명 방식 (오프라인 서버가 수용해야 함)

```
message = METHOD + "\n" + path+search + "\n" + nonce + "\n" + sha256_hex(body)
x-dg-s  = base64url( HMAC_SHA256(sigKey, message) )
x-dg-c  = nonce  (= 증가하는 마이크로초 카운터)
x-dg-build = <클라이언트 번들에 박힌 빌드 해시>
authorization = "Bearer " + token
```
- `sigKey`/`token`은 로그인 시 서버가 발급. body 해시는 **hex** sha256, 서명 출력은 **base64url(무패딩)**.

## 4. WebSocket 메시지 프로토콜

- 총 **197종** 메시지 (`docs/server-message-types.txt` 전체 목록).
- 분류 예: 전투(`MsgBattleStartReq`, `MsgBattleResultAns`, `MsgBattleMatchReq`), 차량(`MsgUpgradeCarReq`, `MsgCombineCarAns`, `MsgSellCarReq`), 경제(`MsgBuyProductReq`, `MsgBuyFuelReq`, `MsgUseItemReq`, `MsgSellPartsReq`), 캐릭터/데이트(`MsgDateStartReq`, `MsgLoadScript`, `MsgCollectFamiliarityReq`), 우편/소셜(`MsgCheckMailBoxReq`, `MsgInviteFriendReq`, `MsgVisitReq`), 월드레이스/PvP(`MsgGetWRaceInfoAns`, `MsgWRaceRewardReq`), 유저데이터(`MsgUserData`, `MsgNotifyEvent`).
- **이것이 오프라인화의 실제 작업량입니다.** 각 메시지의 요청 필드·서버 계산·응답을 재현해야 합니다.

## 5. 게임 데이터 (평문, 확보됨)

`GET /api/content` (약 0.7MB, 비암호화):
- 테이블 12종: `cars, carNames, parts, partsFusion, decals, decalTable, colorTable, itemTable, girlItemTable, battleTable, trackTable, dailyBonusTable, vconstTable`
- `texts`(아이템·UI, 5개 언어), `prices`(22), `currency`, `cosmetics`(191), `rarity`, `boxOdds`(뽑기 확률) 등
- 이 데이터는 오프라인 서버의 규칙 테이블로 바로 쓸 수 있습니다.

## 6. 대본(스토리 대사) 언어 — 확정

`GET /api/scripts` (평문 JSON, 비암호화):
- 구조: `Script`(연출 스텝 39,440개, 스크립트 420편) + `Text`(대사 25,711줄, `TextTag`로 참조)
- **언어 지원은 영어/일본어 2종뿐.** 코드상 `language==="jp"`일 때만 `?lang=jp`(일본어), 그 외(**한국어·중국어·대만어·영어 모두**)는 기본값=**영어**.
- 실측: 기본 응답의 `Text` 25,711줄 중 **95%가 순수 영어, 한글 0줄**. 일본어판은 전량 일본어.
- **결론: 한국어 대사는 존재하지 않습니다. 한국어 사용자도 영어 대사를 받습니다.** (당신 기억과 일치)
- 한국어화하려면 이 25,711줄을 번역해 별도 언어 테이블(`?lang=kr`)로 서버가 제공하도록 추가해야 합니다.

## 7. 에셋 팩 (DRM) — 차단된 지점

- `GET /api/packs`: 팩 **171개, 총 약 1,178 MB (1.18 GB)**. 각 팩에 `kid`(키 ID) 존재 → **암호화**.
- 복호화 키는 `POST /api/keys`로 받아야 하나, 이 키 추출이 **환경 안전 분류기에 의해 DRM 우회로 차단**됨. 본 분석은 이 경계를 우회하지 않음.
- 따라서 **에셋 본체(모델·텍스처·사운드)는 미확보**이며, 완전한 오프라인 실행의 전제인 에셋 복호화는 별도 승인·방법이 필요합니다.

## 8. 오프라인화 + 치트 방안 (권고)

목표: "오프라인 단독 실행 + 치트, 추후 서버/클라이언트 분리 가능". 현실적으로 **로컬 권위 서버를 새로 구현**하는 것이 유일하게 올바른 길입니다(클라이언트만 패치하면 서버 응답이 없어 진행 불가).

권고 아키텍처 — 처음부터 서버/클라이언트 분리형으로:
1. **로컬 서버**(Node 등): `/api/*`와 `/api/pvp` WebSocket을 구현. 로그인은 로컬 계정, 서명은 로컬 sigKey로 검증(또는 무검증 모드).
2. **데이터**: 확보한 `api/content` 테이블을 규칙 DB로 적재. 197개 메시지를 우선순위대로 구현(부트→메인→차량/전투→데이트/스토리→상점→소셜).
3. **치트**: 서버가 권위를 가지므로 치트는 **서버 측 토글**로 둠(재화 무한, 전투 강제승리, 전 차량/캐릭터 해제, 친밀도 즉시 등). 라이브 서버가 아니라 **내 로컬 서버**에만 적용 → 타 플레이어 영향 없음.
4. **에셋**: 7장 해결 후, 복호화된 에셋을 로컬에서 서빙(`assetBase`를 로컬로).
5. **분리 지점**: 클라이언트는 서버 URL만 바꾸면 로컬/원격 모두 접속 가능하도록 설정화. 이 구조면 "나중에 서버/클라이언트 분리"가 설정 하나로 충족됨.

### 작업 순서 제안
1. (승인 시) 에셋 복호화 경로 확정 — 7장
2. `/api/content`·`/api/scripts` 기반 로컬 데이터 레이어 구축 (지금 가능)
3. 부트 플로우에 필요한 최소 메시지 세트부터 로컬 서버 구현 → 클라이언트가 메인 화면까지 뜨는지 검증
4. 메시지 확장 + 치트 토글
5. (선택) 대본 한국어 번역 레이어 추가 — 6장

## 9. 미해결 / 승인 필요
- **에셋 팩 복호화(`api/keys`)**: 안전 분류기 차단. 진행하려면 권한 변경 또는 다른 방법 필요.
- **에뮬레이터 실행 검증**: 현재 환경에 KVM 없음 → 실기기/다른 환경 필요.
