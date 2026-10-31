// 엔진 검증: 합성 자세 시퀀스(정상/빠름/반쪽/정지/타임아웃/노이즈/인식 끊김)
const { computeMetrics, createCounter } = require('./engine.js');

const ASPECT = 16 / 9;
const FPS = 30;

// 측면에서 본 사람(오른쪽을 향함). 정규화 좌표 [x, y]
const POSES = {
  stand:  { shoulder: [0.50, 0.25], hip: [0.50, 0.50], knee: [0.50, 0.70], ankle: [0.50, 0.90] },
  squat:  { shoulder: [0.55, 0.58], hip: [0.46, 0.78], knee: [0.57, 0.72], ankle: [0.50, 0.90] },
  plank:  { shoulder: [0.30, 0.70], hip: [0.50, 0.76], knee: [0.65, 0.80], ankle: [0.80, 0.85] },
};
const IDX = { shoulder: 11, hip: 23, knee: 25, ankle: 27 };
const IDX_R = { shoulder: 12, hip: 24, knee: 26, ankle: 28 };

function lerpPose(a, b, u) {
  const o = {};
  for (const k of Object.keys(a)) o[k] = [a[k][0] + (b[k][0] - a[k][0]) * u, a[k][1] + (b[k][1] - a[k][1]) * u];
  return o;
}

// 키프레임 [{t(초), pose}] → 프레임별 포즈
function poseAt(keys, t) {
  if (t <= keys[0].t) return POSES[keys[0].pose];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const u = (t - keys[i - 1].t) / (keys[i].t - keys[i - 1].t);
      return lerpPose(POSES[keys[i - 1].pose], POSES[keys[i].pose], u);
    }
  }
  return POSES[keys[keys.length - 1].pose];
}

function toLandmarks(p, rng, noise, visDrop) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }));
  const n = () => (noise ? (rng() - 0.5) * 2 * noise : 0);
  for (const k of Object.keys(IDX)) {
    lm[IDX[k]] = { x: p[k][0] + n(), y: p[k][1] + n(), z: 0, visibility: visDrop ? 0.2 : 0.95 };
    lm[IDX_R[k]] = { x: p[k][0] + 0.01 + n(), y: p[k][1] + n(), z: 0, visibility: 0.3 }; // 가려진 쪽
  }
  return lm;
}

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function burpee(t0, dur = 3.0) {
  const s = dur / 3.0;
  return [
    { t: t0, pose: 'stand' }, { t: t0 + 0.6 * s, pose: 'squat' }, { t: t0 + 1.2 * s, pose: 'squat' },
    { t: t0 + 1.6 * s, pose: 'plank' }, { t: t0 + 2.2 * s, pose: 'plank' },
    { t: t0 + 2.6 * s, pose: 'squat' }, { t: t0 + 3.0 * s, pose: 'stand' },
  ];
}

function halfRep(t0) {
  return [{ t: t0, pose: 'stand' }, { t: t0 + 0.8, pose: 'squat' }, { t: t0 + 1.4, pose: 'squat' }, { t: t0 + 2.2, pose: 'stand' }];
}

function run(name, keys, total, opts = {}) {
  const rng = mulberry32(opts.seed || 1);
  const c = createCounter(opts.cfg);
  const events = [];
  for (let f = 0; f * 1000 / FPS <= total * 1000; f++) {
    const tMs = f * 1000 / FPS;
    const p = poseAt(keys, tMs / 1000);
    const dropped = opts.dropRate && rng() < opts.dropRate;
    const lm = toLandmarks(p, rng, opts.noise || 0, dropped);
    const m = computeMetrics(lm, ASPECT, c.config);
    events.push(...c.update(tMs, m));
  }
  const res = { name, count: c.count, invalid: c.invalid, expect: opts.expect, expectInvalidMin: opts.expectInvalidMin || 0 };
  res.pass = res.count === res.expect && res.invalid >= res.expectInvalidMin;
  return res;
}

function concat(...segs) { // 구간 이어붙이기 (각 구간은 stand에서 시작해 stand로 끝남)
  return [].concat(...segs);
}

const results = [];

// 1. 정상 5회 (3초/회)
{ let keys = []; for (let i = 0; i < 5; i++) keys = keys.concat(burpee(1 + i * 3.0)); results.push(run('정상 5회(3s/회)', keys, 18, { expect: 5 })); }
// 2. 빠른 10회 (1.8초/회)
{ let keys = []; for (let i = 0; i < 10; i++) keys = keys.concat(burpee(1 + i * 1.8, 1.8)); results.push(run('빠른 10회(1.8s/회)', keys, 21, { expect: 10 })); }
// 2b. 서 있는 시간이 거의 없는 연속 10회 (1.8초/회) — 위와 동일 입력이지만 노이즈 포함
{ let keys = []; for (let i = 0; i < 10; i++) keys = keys.concat(burpee(1 + i * 1.8, 1.8)); results.push(run('빠른 10회+노이즈', keys, 21, { expect: 10, noise: 0.005, seed: 5 })); }
// 2c. 매우 빠른 8회 (1.4초/회)
{ let keys = []; for (let i = 0; i < 8; i++) keys = keys.concat(burpee(1 + i * 1.4, 1.4)); results.push(run('매우 빠른 8회(1.4s/회)', keys, 14, { expect: 8 })); }
// 3. 반쪽(쪼그려 앉았다 일어섬) 3회 → 0회
{ let keys = []; for (let i = 0; i < 3; i++) keys = keys.concat(halfRep(1 + i * 2.2)); results.push(run('반쪽 동작 3회', keys, 9, { expect: 0, expectInvalidMin: 3 })); }
// 4. 가만히 서 있기 10초
results.push(run('정지 10초', [{ t: 0, pose: 'stand' }, { t: 10, pose: 'stand' }], 10, { expect: 0 }));
// 5. 쪼그려 앉아 6초 유지 후 포기 → 0회 (타임아웃 무효)
results.push(run('쪼그려 6초 유지(무효)', [{ t: 0, pose: 'stand' }, { t: 0.6, pose: 'squat' }, { t: 7, pose: 'squat' }, { t: 7.6, pose: 'stand' }], 9, { expect: 0, expectInvalidMin: 1 }));
// 6. 노이즈 ±0.5% 좌표 흔들림, 5회
{ let keys = []; for (let i = 0; i < 5; i++) keys = keys.concat(burpee(1 + i * 3.0)); results.push(run('노이즈 ±0.005, 5회', keys, 18, { expect: 5, noise: 0.005, seed: 7 })); }
// 7. 노이즈 ±1%, 5회
{ let keys = []; for (let i = 0; i < 5; i++) keys = keys.concat(burpee(1 + i * 3.0)); results.push(run('노이즈 ±0.01, 5회', keys, 18, { expect: 5, noise: 0.01, seed: 11 })); }
// 8. 10% 프레임 인식 실패, 5회
{ let keys = []; for (let i = 0; i < 5; i++) keys = keys.concat(burpee(1 + i * 3.0)); results.push(run('인식 실패 10%, 5회', keys, 18, { expect: 5, dropRate: 0.10, seed: 3 })); }
// 9. 정상 + 반쪽 섞기: 2 정상 + 1 반쪽 + 2 정상 = 4
{ let keys = []; let t = 1; for (let i = 0; i < 2; i++) { keys = keys.concat(burpee(t)); t += 3; } keys = keys.concat(halfRep(t)); t += 2.2; for (let i = 0; i < 2; i++) { keys = keys.concat(burpee(t)); t += 3; } results.push(run('정상2+반쪽1+정상2', keys, t + 1, { expect: 4, expectInvalidMin: 1 })); }
// 10. 느린 버피 (6초/회) 4회: 플랭크 구간이 길어도 타임아웃 안 걸려야 함
{ let keys = []; for (let i = 0; i < 4; i++) keys = keys.concat(burpee(1 + i * 6.0, 6.0)); results.push(run('느린 4회(6s/회)', keys, 26, { expect: 4 })); }

let fail = 0;
for (const r of results) {
  const ok = r.pass ? 'PASS' : 'FAIL';
  if (!r.pass) fail++;
  console.log(`${ok}  ${r.name.padEnd(26)} count=${r.count} (기대 ${r.expect})  무효=${r.invalid}`);
}
console.log(fail === 0 ? '\n전체 통과' : `\n실패 ${fail}건`);
process.exit(fail ? 1 : 0);
