# Drift Girls Reborn — 오프라인 서버 (부트~메인 단계)

클라이언트가 **코드 수정 없이** 접속하는 로컬 권위 서버. Node.js + TypeScript + SQLite. 설계는 `DESIGN.md`.

## 검증 결과 (2026-11-01, 헤드리스 Chromium, 외부 요청 0건)
클라이언트 빌드 `b3ff0b7…` + 사용자 제공 평문 에셋으로 **로그인 → 로딩 → 메인 진입(이벤트·보상 팝업, 3D 차량 렌더)** 까지 확인.
요청 417건 전부 200, `/api/rpc` 9건 미구현 메시지 없음. 실시간 `/api/pvp` 만 미구현(인증 실패 로그).

## 현재 구현 상태
- [x] `/api/login` (느슨 인증: 아무 계정이나 통과, 로컬 토큰·sigKey 발급)
- [x] `/api/content` (게임 규칙 테이블·텍스트 서빙)
- [x] `/api/scripts` (스토리 대사; 기본=영어, `?lang=jp`=일본어)
- [x] `/api/packs` (매니페스트 서빙; 에셋 본체는 별도)
- [x] `/api/session`, `/api/notices/active`, `/api/news`, `/api/news/seen` (오프라인용 빈 응답)
- [x] 응답 서명(`x-dg-s`, `res\n<nonce>\n<sha256(body)>`) — 클라이언트 검증 통과
- [x] `/sw.js` 자체 작성 통과형 서비스워커(원본 미사용), 평문 에셋 모드에서 `/api/packs` 빈 목록
- [x] 평문 에셋 `/a/local/**` → `data/assets/**`, 테이블 `/a/local/data/*.json` → `data/tables/*`
- [x] `/api/rpc` 디스패처 + `MsgLoginReq` → `[MsgLoginAns, MsgUserData]`, `MsgSetOptionReq`, `MsgUpdateCompletionReq`
- [ ] 메인 화면 조작 메시지 (차량·상점·데이트 …) — 2단계
- [ ] `MsgCheatReq` 전체 토글 — 2단계
- [ ] `/api/pvp` WebSocket (실시간 레이스) — 4단계
- [x] 에셋 서빙 — 사용자 제공 평문(`data/assets/`, `data/tables/`)

검증: 위 부트 경로는 curl 로 end-to-end 확인됨(login→content→rpc MsgLoginReq→scripts 모두 200).

## 준비

### 1) 평문 데이터 내려받기 (본인 계정)
서버는 게임 데이터(테이블·대사)를 `data/` 에서 읽는다. 저장소에는 포함하지 않는다(`data/` gitignore).
```
npm install
node scripts/fetch-data.mjs <본인_로그인> <본인_비밀번호>
```
→ `data/content.json`, `data/scripts.json`, `data/scripts_jp.json`, `data/packs.json`, `data/userdata-seed.json` 생성.
`userdata-seed.json` 은 본인 현재 계정 상태를 오프라인 시작점으로 쓰기 위한 시드(없으면 신규계정으로 시작).

### 2) 에셋 (암호화 팩) — 본 서버 범위 밖
팩 1.18GB 는 서버 발급 키로 암호화돼 있다. **복호화는 사용자가 수행**하고, 결과를 `data/assets/` 에 둔다. 이 저장소 코드는 복호화를 수행하지 않는다.

## 실행
```
npm run build && npm start      # 또는 npm run dev
# http://localhost:8080
```

## 클라이언트를 로컬 서버로 연결
클라이언트 번들은 `https://game.driftgirlsreborn.com` 을 가리킨다. 로컬 서버로 붙이려면 둘 중 하나:
- APK/클라이언트의 서버 URL을 `http://<로컬IP>:8080` 로 변경(2단계에서 다룸), 또는
- 해당 도메인을 로컬 서버로 DNS/hosts 리다이렉트.

메인 화면이 **그려지려면 에셋이 필요**하다(위 2). 에셋 없이도 서버 API 계약은 위 curl 검증대로 동작한다.

## 설정 `config.json`
- `strictSignatures`: `false`(오프라인 기본). `true` 로 바꾸면 `x-dg-s` HMAC 검증(원격 분리용).
- `cheat`: 서버측 치트 토글. 라이브 서버가 아닌 **로컬 서버에만** 적용되므로 타 플레이어 영향 없음.
- `upstream`: `scripts/fetch-data.mjs` 전용. 서버 런타임은 upstream 을 호출하지 않는다.

## 클라이언트 연결 (상세)
`tools/repoint-apk.sh` 로 APK를 로컬 서버로 재지정한다. `tools/README.md` 참고.
