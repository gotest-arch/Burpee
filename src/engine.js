// ===== ENGINE START =====
// 변형 버피 횟수 판정 엔진 (순수 함수, DOM/카메라 의존 없음)
// 입력: MediaPipe Pose 랜드마크(정규화 좌표 0~1, visibility 포함) → 출력: 지표, 단계, 횟수
const ENGINE_VERSION = 'rules-0.2';

const DEFAULT_CONFIG = {
  kneeStandMin: 160,      // 서기: 무릎 각도 이 값 이상
  kneeSquatMax: 105,      // 쪼그려 앉기: 무릎 각도 이 값 이하
  tiltPlankMax: 30,       // 플랭크: 어깨-발목 선의 수평 대비 기울기(도) 이 값 이하
  tiltStandMin: 60,       // 서기: 기울기 이 값 이상 (몸이 세워져 있음)
  squatMaxMs: 4000,       // 쪼그려 앉기 단계 최대 체류 시간
  plankMaxMs: 5000,       // 플랭크 단계 최대 시간 (복귀 이동 포함)
  minPhaseMs: 120,        // 쪼그려 앉기·플랭크가 이 시간 이상 유지돼야 인정 (떨림 방지)
  minStandMs: 0,          // 플랭크 후 일어서는 동작은 즉시 인정
  minVisibility: 0.5,     // 랜드마크 신뢰도 하한
  smoothing: 0.5          // 지표 지수이동평균 계수 (0=이전값 유지, 1=평활 없음)
};

const LM = {
  L: { shoulder: 11, hip: 23, knee: 25, ankle: 27 },
  R: { shoulder: 12, hip: 24, knee: 26, ankle: 28 }
};

function angleDeg(a, b, c) { // 점 b에서 a-b-c가 이루는 각도
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (n === 0) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, dot / n))) * 180 / Math.PI;
}

// 카메라에 더 잘 보이는 쪽(왼/오른)의 랜드마크만 사용
function pickSide(lm) {
  const score = (s) => (lm[s.shoulder].visibility + lm[s.hip].visibility + lm[s.knee].visibility + lm[s.ankle].visibility) / 4;
  return score(LM.L) >= score(LM.R) ? 'L' : 'R';
}

// aspect = 영상 가로/세로. x를 aspect배 해서 화면 비율 왜곡 없이 각도 계산
function computeSide(lm, aspect, cfg) {
  cfg = cfg || DEFAULT_CONFIG;
  if (!lm || lm.length < 29) return { ok: false, reason: 'nolandmarks' };
  const side = pickSide(lm);
  const ids = LM[side];
  const pts = {};
  for (const k of Object.keys(ids)) {
    const p = lm[ids[k]];
    if (!p || p.visibility < cfg.minVisibility) return { ok: false, reason: 'lowvis', side };
    pts[k] = { x: p.x * aspect, y: p.y, vis: p.visibility, rx: p.x, ry: p.y };
  }
  const knee = angleDeg(pts.hip, pts.knee, pts.ankle);
  const dx = Math.abs(pts.ankle.x - pts.shoulder.x);
  const dy = Math.abs(pts.ankle.y - pts.shoulder.y);
  const tilt = Math.atan2(dy, dx) * 180 / Math.PI; // 0=수평, 90=수직
  const inFrame = Object.values(pts).every(p => p.rx > 0.01 && p.rx < 0.99 && p.ry > 0.01 && p.ry < 0.99);
  return { ok: true, view: 'side', side, knee, tilt, inFrame };
}

// ---- 정면 촬영: 모델이 주는 3D(월드) 좌표로 각도 계산 (촬영 방향과 무관) ----
function angle3(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y, a.z - b.z], v2 = [c.x - b.x, c.y - b.y, c.z - b.z];
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const n = Math.hypot(v1[0], v1[1], v1[2]) * Math.hypot(v2[0], v2[1], v2[2]);
  if (!n) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, dot / n))) * 180 / Math.PI;
}
function sideVisible(lm, ids, minVis) { return ['shoulder', 'hip', 'knee', 'ankle'].every(k => lm[ids[k]] && lm[ids[k]].visibility >= minVis); }

// 정면 여부: 어깨 폭 / 몸통 길이 (정면이면 ~0.8, 측면이면 ~0.1)
function frontness(lm, aspect) {
  const a = lm[11], b = lm[12], c = lm[23], d = lm[24];
  if (!a || !b || !c || !d || Math.min(a.visibility, b.visibility, c.visibility, d.visibility) < 0.5) return null;
  const sep = Math.abs(a.x - b.x) * aspect;
  const sx = (a.x + b.x) / 2 * aspect, sy = (a.y + b.y) / 2, hx = (c.x + d.x) / 2 * aspect, hy = (c.y + d.y) / 2;
  const torso = Math.hypot(sx - hx, sy - hy);
  return torso > 0 ? sep / torso : null;
}

function computeFront(lm, aspect, cfg) {
  const w = lm && lm.world;
  if (!w || w.length < 29) return { ok: false, view: 'front', reason: 'noworld' };
  const sides = ['L', 'R'].filter(s => sideVisible(lm, LM[s], cfg.minVisibility));
  if (!sides.length) return { ok: false, view: 'front', reason: 'lowvis' };
  const knees = sides.map(s => angle3(w[LM[s].hip], w[LM[s].knee], w[LM[s].ankle]));
  const knee = knees.reduce((p, c) => p + c, 0) / knees.length;
  const mid = (k) => ({ x: sides.reduce((p, s) => p + w[LM[s][k]].x, 0) / sides.length, y: sides.reduce((p, s) => p + w[LM[s][k]].y, 0) / sides.length, z: sides.reduce((p, s) => p + w[LM[s][k]].z, 0) / sides.length });
  const sh = mid('shoulder'), an = mid('ankle');
  // 월드 좌표의 y축을 수직으로 본다 (폰이 대체로 세워져 있다고 가정). 어깨-발목 선이 수평에 가까우면 플랭크.
  const tilt = Math.atan2(Math.abs(sh.y - an.y), Math.hypot(sh.x - an.x, sh.z - an.z)) * 180 / Math.PI;
  const inFrame = sides.every(s => Object.keys(LM[s]).every(k => { const p = lm[LM[s][k]]; return p.x > 0.01 && p.x < 0.99 && p.y > 0.01 && p.y < 0.99; }));
  return { ok: true, view: 'front', side: sides.join(''), knee, tilt, inFrame };
}

// view: 'side'(기본, 화면 좌표) | 'front'(3D 월드 좌표)
function computeMetrics(lm, aspect, cfg, view) {
  cfg = cfg || DEFAULT_CONFIG;
  return view === 'front' ? computeFront(lm, aspect, cfg) : computeSide(lm, aspect, cfg);
}

const STATES = ['STAND', 'SQUAT', 'PLANK'];

function createCounter(userCfg) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, userCfg || {});
  let state = 'STAND';
  let stateSince = 0;       // 현재 단계 진입 시각(ms)
  let candidate = null;     // 전이 후보 {to, since}
  let count = 0;
  let invalid = 0;          // 무효 처리된 시도 수
  let sm = null;            // 평활된 지표
  let started = false;

  function smooth(m) {
    if (!sm) { sm = { knee: m.knee, tilt: m.tilt }; return sm; }
    const a = cfg.smoothing;
    sm = { knee: sm.knee * (1 - a) + m.knee * a, tilt: sm.tilt * (1 - a) + m.tilt * a };
    return sm;
  }

  function classify(s) {
    // 각 지표가 어느 자세에 해당하는지 (애매하면 null)
    if (s.knee >= cfg.kneeStandMin && s.tilt >= cfg.tiltStandMin) return 'STAND';
    if (s.tilt <= cfg.tiltPlankMax) return 'PLANK';
    if (s.knee <= cfg.kneeSquatMax) return 'SQUAT';
    return null;
  }

  function goto(next, t) { state = next; stateSince = t; candidate = null; }

  // t: 밀리초 시각, m: computeMetrics 결과. 반환: 이벤트 배열
  function update(t, m) {
    const events = [];
    if (!started) { started = true; stateSince = t; }
    if (!m || !m.ok) return events; // 인식 실패 프레임은 건너뜀 (타임아웃은 계속 진행)
    const s = smooth(m);
    const seen = classify(s);

    // 타임아웃: 한 단계에 너무 오래 머물면 이번 시도는 무효
    if (state === 'SQUAT' && t - stateSince > cfg.squatMaxMs) { invalid++; events.push({ type: 'invalid', t, reason: 'squat-timeout' }); goto('STAND', t); return events; }
    if (state === 'PLANK' && t - stateSince > cfg.plankMaxMs) { invalid++; events.push({ type: 'invalid', t, reason: 'plank-timeout' }); goto('STAND', t); return events; }

    // 허용 전이: STAND→SQUAT, SQUAT→PLANK, PLANK→STAND(횟수+1)
    // 플랭크에서 복귀하는 중 쪼그려 앉기는 허용(상태 유지), 서기 도달 시 완료
    let want = null;
    if (state === 'STAND' && seen === 'SQUAT') want = 'SQUAT';
    else if (state === 'SQUAT' && seen === 'PLANK') want = 'PLANK';
    else if (state === 'SQUAT' && seen === 'STAND') want = 'STAND'; // 중간에 일어섬 → 시도 무효
    else if (state === 'PLANK' && seen === 'STAND') want = 'STAND';

    if (want) {
      if (!candidate || candidate.to !== want) candidate = { to: want, since: t };
      // 플랭크에서 일어서는 순간은 즉시 인정(빠른 연속 동작은 서 있는 시간이 거의 없음)
      const need = (state === 'PLANK' && want === 'STAND') ? cfg.minStandMs : cfg.minPhaseMs;
      if (t - candidate.since >= need) {
        const prev = state;
        if (prev === 'PLANK' && want === 'STAND') {
          count++;
          events.push({ type: 'rep', t, count });
        } else if (prev === 'SQUAT' && want === 'STAND') {
          invalid++;
          events.push({ type: 'invalid', t, reason: 'half-rep' });
        } else {
          events.push({ type: 'phase', t, from: prev, to: want });
        }
        goto(want, t);
      }
    } else {
      candidate = null;
    }
    return events;
  }

  return {
    update,
    get state() { return state; },
    get count() { return count; },
    get invalid() { return invalid; },
    get smoothed() { return sm; },
    reset() { state = 'STAND'; stateSince = 0; candidate = null; count = 0; invalid = 0; sm = null; started = false; },
    config: cfg
  };
}
// ===== ENGINE END =====

if (typeof module !== 'undefined') module.exports = { ENGINE_VERSION, DEFAULT_CONFIG, computeMetrics, createCounter, angleDeg, pickSide, frontness };
