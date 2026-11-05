#!/usr/bin/env bash
# 봇 감시 루프: 종료되면 다시 띄운다 (STOP 파일이 있으면 끝)
D=$(dirname "$0"); OUT=$D/run
while true; do
  node $D/bot.cjs $OUT 20 >> $OUT/node.out 2>&1
  [ -f $OUT/STOP ] && break
  sleep 5
done
