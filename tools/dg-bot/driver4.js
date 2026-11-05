(() => {
  const bot = window.__bot = window.__bot || { log: [], grades: [] };
  if (bot.timer) clearInterval(bot.timer);
  const r0 = globalThis.__dgRace;
  if (r0 && bot.installed === r0) { for (const k of ['fixedUpdate', 'update', 'advance']) delete r0[k]; }
  bot.installed = null;
  bot.timer = setInterval(() => {
    const r = globalThis.__dgRace;
    if (!r || bot.installed === r) return;
    bot.installed = r; bot.grades = []; bot.boosts = 0; bot.log.push('install4 ' + Date.now());
    const pts = r.driftActionPoints, P = Object.getPrototypeOf(r);
    let lastD = null, lastIdx = -1, steps = 0, minD = 99, subs = 0;
    const dist = () => { const i = r.currentDriftActionPointIndex; if (r.raceState !== 2 || i >= pts.length) return null;
      const p = pts[i], t = r.playerCar.transform; return Math.hypot(t.x - p.x, t.z - p.z); };
    const fire = (why, d) => {
      const i = r.currentDriftActionPointIndex, p = pts[i];
      r.onDriftButton(i % 2 === 0, i % 2 === 0 ? p.isRight : r.currentDriftIsRight);
      // 니트로 세기 = ln(d^0.25*0.1)/ln(0.2) x 속도항: 드리프트 지점 바로 위에서 쓰면 약 2배 (멀면 0.8)
      try { const c = r.playerCar, e = r.enemyCar;
        // smart: 상대가 응답 부스터를 쓸 수 있으면(충전 1 이상, 간격 -10~60m: RivalPacing.onPlayerBooster) 아껴 둔다
        const gap = e ? c.raceSim.accumDistance - e.raceSim.accumDistance : 0;
        const answer = e && r.rivalPacing && e.boosterCharge >= 1 && gap >= -10 && gap <= 60;
        if (c.boosterCount > 0 && !(c.boostCount > 0) && !(window.__botSmart && answer)) { r.clickBooster(); bot.boosts = (bot.boosts || 0) + 1; } } catch (e) {}
      bot.grades.push({ i, d: +d.toFixed(3), min: +minD.toFixed(3), g: r.lastGradeType, why, subs });
      lastD = null; minD = 99; subs = 0; lastIdx = r.currentDriftActionPointIndex;
    };
    const check = () => {
      const d = dist(); if (d === null) return;
      const i = r.currentDriftActionPointIndex;
      if (lastIdx !== i) { lastIdx = i; lastD = null; minD = 99; }
      if (d < minD) minD = d;
      if (d < 0.065) return fire('crazy', d);
      // 실험: 지점 i>=2 에서 가장 가까워지기 전 lead m 안에 들어오면 미리 누른다 (짝수=드리프트 시작, 홀수=끝)
      const lead = i % 2 === 0 ? window.__botLead : window.__botLeadEnd;
      if (lead && i >= 2 && d < lead) return fire('lead', d);
      if (lastD !== null && d > lastD + 1e-6 && d < 25) return fire('pass', d);
      lastD = d;
    };
    r.advance = function (dt) {
      let rem = Math.min(dt, 0.1);
      while (rem > 1e-9) {
        const d = dist();
        const s = Math.min(d !== null && d < 2 ? 0.0004 : 0.004, rem);
        if (d !== null && d < 2) subs++;
        P.advance.call(r, s); rem -= s;
        try { check(); } catch (e) { bot.log.push('err ' + e); }
      }
    };
    r.fixedUpdate = function () {
      try { if (r.raceState === 2 && ++steps % 50 === 0 && r.currentDriftActionPointIndex >= pts.length) r.clickBooster(); } catch (e) {} // 마지막 지점 뒤: 남은 니트로 소진
      return P.fixedUpdate.call(r);
    };
    r.update = function (dt) {
      try { if (r.raceState === 1) r.isPressStartButton = r.needleZ < (Number(r.startMinRPM) + Number(r.startMaxRPM)) / 2; } catch (e) {}
      return P.update.call(r, dt);
    };
  }, 50);
  return 'ok4';
})()
