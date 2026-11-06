#!/usr/bin/env bash
# 봇 감시 루프: 종료되면 다시 띄운다 (STOP 파일이 있으면 끝)
# 60초 안에 끝나면 같은 원인으로 바로 또 끝날 가능성이 크므로 5분 쉰다
#   (2026-11-06 02:44: RacePos 0 판정 오류로 7초마다 재시작·로그인이 7분간 반복됐다)
D=$(dirname "$0"); OUT=$D/run
while true; do
  T0=$(date +%s)
  node $D/bot.cjs $OUT 20 >> $OUT/node.out 2>&1
  [ -f $OUT/STOP ] && break
  if [ $(( $(date +%s) - T0 )) -lt 60 ]; then echo "[$(date -u +%m-%dT%H:%M:%S)] quick exit -> wait 300s" >> $OUT/bot.log; sleep 300; else sleep 5; fi
done
