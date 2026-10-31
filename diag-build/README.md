# 진단용 APK (1.0.4-diag)

원본 APK에 **크래시 기록을 공용 Download 폴더로 내보내는 기능만** 추가한 빌드입니다. 게임 동작은 바꾸지 않았습니다.

## 변경 내용
- `MainActivity` 부트 스레드에서 종료 사유를 기록한 직후에 `DiagExport.run(this)`를 호출하도록 smali 1줄을 추가했습니다. 원본 dex와 비교하면 이 명령어 1개만 다릅니다.
- `DiagExport`는 `classes2.dex`로 들어갑니다. 소스는 `src/` 폴더에 있습니다.
- 매니페스트, 리소스, 권한, versionCode(5)는 원본과 같습니다.

## 저장되는 시점
- 이 빌드를 처음 실행할 때 1회 (내보내기가 동작하는지 확인용)
- 이후에는 직전 실행에서 비정상 종료가 있었을 때마다: 네이티브 크래시, Java 크래시, ANR, 메모리 부족, 리소스 과다 사용, freezer, WebView 렌더러 소실

## 저장 위치와 내용
- 위치: `Download/DriftGirlsDiag/DriftGirls-diag-YYYYMMDD-HHMMSS.json` (Android 10 이상, 권한 불필요)
- 내용:
  - 기기 정보: SoC, GPU 렌더러 문자열, Android 버전, WebView 버전, 메모리
  - 최근 종료 사유 16건: 네이티브 크래시는 톰스톤 원본, ANR은 trace 원본 (base64)
  - 앱 자체 진단 기록 `events.json`
  - 이 앱의 logcat

## 빌드 방법
```
ANDROID_HOME=<sdk> APKTOOL=<apktool_2.12.1.jar> ./build.sh <원본.apk> <출력.apk> <keystore.jks> <storepass>
```

## 주의
- 원본과 서명 키가 다르므로 **기존 앱을 삭제한 뒤 설치**해야 합니다. 추가 데이터는 다시 다운로드하게 됩니다.
- 서버가 새 versionCode의 APK를 배포하면 앱 내 업데이트는 서명이 달라 실패합니다. 진단을 마친 뒤 원본 계열로 다시 설치하면 됩니다.
