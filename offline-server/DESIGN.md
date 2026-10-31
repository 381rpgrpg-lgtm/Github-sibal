# 오프라인 서버 설계 (확정본)

클라이언트 소스 분석으로 확인한 프로토콜에 맞춰, Drift Girls Reborn 클라이언트가 **코드 수정 없이** 접속할 수 있는 로컬 권위 서버를 구현한다. 나중에 원격 서버/클라이언트로 분리 가능하도록 처음부터 경계를 설정화한다.

## 확정 사항
- 언어/스택: **Node.js + TypeScript**
- 상태 저장: **SQLite** (저장 계층을 추상화해 추후 분리 대비)
- 구현 순서: **부트 → 메인 화면 먼저**, 이후 점진 확장
- 치트: 클라이언트에 내장된 **`MsgCheatReq`** 메시지를 로컬 서버가 수용 + 서버측 토글
- 에셋(암호화 팩 1.18GB): 본 서버 범위 밖. 사용자가 복호화해 `data/assets/`에 두면 서버가 서빙.

## 전송 계층 (확인됨)
클라이언트는 두 경로를 가진다.
1. **HTTP RPC (기본·필수):** `POST /api/rpc {name, body}` → `{messages:[{name, body}, …]}`. 한 요청이 여러 응답 메시지를 반환.
2. **WebSocket (`/api/pvp`, 실시간용):** `hello{time,nonce}` → `auth{token, sig=HMAC("ws\n"+nonce)}` → `welcome`. 이후 `{t:"Msg…", …}` 프레임. **부트~메인에는 불필요**, PvP 단계에서 구현.

## 인증 (확인됨)
- `POST /api/login {login,password}` → `{token, sigKey, assetBase, packs, content, account, expires}`
- 인증 요청 서명: `x-dg-s = base64url(HMAC_SHA256(sigKey, METHOD+"\n"+path+search+"\n"+nonce+"\n"+sha256hex(body)))`, `x-dg-c=nonce`, `x-dg-build`, `authorization: Bearer <token>`
- **로컬 서버는 서명 검증을 "무검증/느슨" 모드로** 두어 단일 오프라인 유저를 바로 통과시킨다(원격 분리 시 엄격 모드 토글).

## 부트 플로우 (확인됨, 구현 대상)
```
1. 클라이언트 → GET /          (클라이언트 번들; 로컬은 캐시/프록시로 서빙)
2. POST /api/login            → 토큰·sigKey·assetBase·버전
3. GET  /api/content          → 테이블 12종 + texts/prices/odds (규칙 데이터)
4. GET  /api/scripts          → 스토리 대사(영어; 선택적 kr 레이어)
5. GET  /api/packs            → 팩 매니페스트 (에셋 확보 후)
6. POST /api/rpc MsgLoginReq  → [MsgLoginAns{Seq,Result,Accountid}, MsgUserData{전체 계정 스냅샷}]
7. 클라이언트 EnterGame()     → 신규계정이면 튜토리얼, 아니면 메인
```

### MsgUserData 스냅샷 필드 (확인됨)
`UserInfo, Cars, Items, RaceZones, dailyRaceDay, StoreSet, OnedayFreeShop, NewShopItems, Cosmetics, MyMemorySet, Collections, MyGirls, GirlItems, GirlMemorySet, DateZone, Ggraph, GirlRarityExpandId, EventRaceTime, NquestInfos, MailBox, SocialBox, mailSeq, PropertySet, GachaPity, PartsPity, PartsPityHq, RaceLevels, NoticeInfo, Daygift, Seasonal`

→ 이 스냅샷을 SQLite의 유저 상태로 저장하고, MsgLoginReq 시 조립해 반환한다.

## REST 엔드포인트 구현 우선순위
| 단계 | 엔드포인트 | 상태 |
|---|---|---|
| 1 | `/api/login`, `/api/session`, `/api/content`, `/api/scripts`, `/api/rpc`(MsgLoginReq) | 부트~메인 (지금) |
| 2 | `/api/rpc`(차량·아이템·상점·데이트 등 메인 화면 조작) | 다음 |
| 3 | `/api/packs` + 에셋 서빙 | 에셋 확보 후 |
| 4 | `/api/pvp` WebSocket (실시간 레이스/PvP) | 마지막 |

## 메시지 197종 구현 순서 (부트~메인 우선)
1. **부트 필수:** `MsgLoginReq`, `MsgUserData`, `MsgUpdateCompletionReq`, `MsgFirstSelectReq`, `MsgSetOptionReq`
2. **메인 화면 상호작용:** `MsgSetCurrentCarReq`, `MsgSetMainGirlReq`, `MsgSetNicknameReq`, `MsgCheckMailBoxReq`, `MsgGetMailItemReq`, `MsgHideNewShopItemReq`, `MsgCosmeticSeenReq`
3. **차량/파츠:** `MsgUpgradeCarReq`, `MsgCombineCarReq`, `MsgSellCarReq`, `MsgSellPartsReq`, `MsgExpandSlotReq`, `MsgCarSlotCostReq`
4. **경제:** `MsgBuyProductReq`, `MsgBuyFuelReq`, `MsgBuyItemReq`, `MsgUseItemReq`, `MsgUseCouponReq`
5. **캐릭터/스토리:** `MsgDateStartReq`, `MsgDateStopReq`, `MsgLoadScript`, `MsgScriptProgressReq`, `MsgCollectFamiliarityReq`, `MsgGetMemoryRewardReq`
6. **전투/레이스:** `MsgBattleMatchReq`, `MsgBattleStartReq`, `MsgBattleResultReq`, `MsgRaceRewardReq`, `MsgRefreshEventRaceReq`
7. **월드레이스/소셜/퀘스트:** `MsgGetWRaceInfoReq`, `MsgWRaceRewardReq`, `MsgVisitReq`, `MsgInviteFriendReq`, `MsgUpdateNquestReq`, `MsgGetDailyQuestRewardReq`
8. **치트:** `MsgCheatReq` (서버 토글: 재화/연료 최대, 전차량·전캐릭터 해제, 전투 강제승리, 친밀도 즉시 등)

전체 목록은 `docs/server-message-types.txt`.

## 디렉터리 구조
```
offline-server/
  src/
    index.ts          HTTP(+정적) 서버, 라우팅
    auth.ts           /api/login, 세션, 서명(느슨/엄격 토글)
    rpc.ts            /api/rpc 디스패처 (name → handler → messages[])
    db.ts             SQLite 저장 계층(추상화)
    content.ts        /api/content, /api/scripts 로더
    handlers/
      boot.ts         MsgLoginReq → [MsgLoginAns, MsgUserData]
      ...             (단계별 추가)
  data/               (gitignore) content.json, scripts.json, assets/
  config.json         서버 URL·엄격모드·치트 토글
```

## 분리(서버/클라이언트) 전략
- 클라이언트는 접속 base URL만 바꾸면 로컬/원격 모두 접속. 서명 검증 엄격모드와 계정 DB만 원격용으로 켜면 그대로 멀티유저 서버가 된다.
- 저장 계층(`db.ts`)을 인터페이스로 두어 SQLite ↔ 외부 DB 교체 가능.
