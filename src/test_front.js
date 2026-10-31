// 정면 촬영 검증: 3D 월드 좌표(미터, y 아래, z는 카메라 쪽)로 만든 합성 자세
const { computeMetrics, createCounter, frontness } = require('./engine.js');
const ASPECT = 16 / 9, FPS = 30, SCALE = 2.2;

// 관절 3D 좌표 [x,y,z] (왼쪽은 +x, 오른쪽은 -x 부호로 좌우 대칭). 사람은 카메라를 바라봄(앞 = +z)
const J = (sh, hip, kn, an) => ({ sh, hip, kn, an });
const POSES = {
  stand: J([0.20, -0.50, 0], [0.10, 0, 0], [0.11, 0.45, 0], [0.11, 0.85, 0]),
  squat: J([0.20, 0.00, 0.20], [0.10, 0.30, -0.15], [0.12, 0.30, 0.25], [0.11, 0.85, 0]),
  plank: J([0.20, 0.60, 0.00], [0.10, 0.70, -0.45], [0.10, 0.78, -0.65], [0.10, 0.85, -0.90]),
};
const IDX = { L: { sh: 11, hip: 23, kn: 25, an: 27 }, R: { sh: 12, hip: 24, kn: 26, an: 28 } };

function lerp(a, b, u) { const o = {}; for (const k in a) o[k] = a[k].map((v, i) => v + (b[k][i] - v) * u); return o; }
function poseAt(keys, t) {
  if (t <= keys[0].t) return POSES[keys[0].pose];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i].t) return lerp(POSES[keys[i - 1].pose], POSES[keys[i].pose], (t - keys[i - 1].t) / (keys[i].t - keys[i - 1].t));
  return POSES[keys[keys.length - 1].pose];
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// 정면 카메라: 이미지 좌표는 x,y만 투영(깊이 z는 사라짐), 월드 좌표는 3D 그대로
function toLandmarks(p, rng, noiseW, noiseI, dropped) {
  const n = (s) => (s ? (rng() - 0.5) * 2 * s : 0);
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }));
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? 1 : -1;
    for (const k of ['sh', 'hip', 'kn', 'an']) {
      const [x, y, z] = p[k]; const id = IDX[side][k];
      lm[id] = { x: 0.5 + sign * x / SCALE + n(noiseI), y: 0.55 + y / SCALE + n(noiseI), z: 0, visibility: dropped ? 0.2 : 0.95 };
      world[id] = { x: sign * x + n(noiseW), y: y + n(noiseW), z: z + n(noiseW) };
    }
  }
  lm.world = world;
  return lm;
}
function burpee(t0, dur = 3.0) {
  const s = dur / 3.0;
  return [{ t: t0, pose: 'stand' }, { t: t0 + 0.6 * s, pose: 'squat' }, { t: t0 + 1.2 * s, pose: 'squat' }, { t: t0 + 1.6 * s, pose: 'plank' }, { t: t0 + 2.2 * s, pose: 'plank' }, { t: t0 + 2.6 * s, pose: 'squat' }, { t: t0 + 3.0 * s, pose: 'stand' }];
}
function halfRep(t0) { return [{ t: t0, pose: 'stand' }, { t: t0 + 0.8, pose: 'squat' }, { t: t0 + 1.4, pose: 'squat' }, { t: t0 + 2.2, pose: 'stand' }]; }

function run(name, keys, total, o = {}) {
  const rng = mulberry32(o.seed || 1), c = createCounter();
  for (let f = 0; f * 1000 / FPS <= total * 1000; f++) {
    const t = f * 1000 / FPS;
    const lm = toLandmarks(poseAt(keys, t / 1000), rng, o.noiseW || 0, o.noiseI || 0, o.dropRate && rng() < o.dropRate);
    c.update(t, computeMetrics(lm, ASPECT, c.config, 'front'));
  }
  const pass = c.count === o.expect && c.invalid >= (o.invMin || 0);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} count=${c.count} (기대 ${o.expect})  무효=${c.invalid}`);
  return pass;
}
const many = (n, dur, start = 1) => { let k = []; for (let i = 0; i < n; i++) k = k.concat(burpee(start + i * dur, dur)); return k; };

const r = [];
r.push(run('정면 정상 5회(3s)', many(5, 3), 18, { expect: 5 }));
r.push(run('정면 빠른 8회(1.8s)', many(8, 1.8), 17, { expect: 8 }));
r.push(run('정면 반쪽 3회', [].concat(halfRep(1), halfRep(3.4), halfRep(5.8)), 9, { expect: 0, invMin: 3 }));
r.push(run('정면 정지 10초', [{ t: 0, pose: 'stand' }, { t: 10, pose: 'stand' }], 10, { expect: 0 }));
r.push(run('정면 노이즈 3cm/0.4%', many(5, 3), 18, { expect: 5, noiseW: 0.03, noiseI: 0.004, seed: 7 }));
r.push(run('정면 노이즈 5cm/0.8%', many(5, 3), 18, { expect: 5, noiseW: 0.05, noiseI: 0.008, seed: 11 }));
r.push(run('정면 인식 실패 10%', many(5, 3), 18, { expect: 5, dropRate: 0.1, seed: 3 }));
r.push(run('정면 느린 4회(6s)', many(4, 6), 26, { expect: 4 }));

// 정면/측면 자동 판별 (서 있는 자세)
const rng = mulberry32(5);
const fr = frontness(toLandmarks(POSES.stand, rng, 0, 0.003, false), ASPECT);
const sideLm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }));
for (const [i, x, y] of [[11, 0.50, 0.25], [12, 0.51, 0.25], [23, 0.50, 0.50], [24, 0.51, 0.50]]) sideLm[i] = { x, y, z: 0, visibility: 0.95 };
const sd = frontness(sideLm, ASPECT);
const okView = fr > 0.55 && sd < 0.35;
console.log(`${okView ? 'PASS' : 'FAIL'}  정면/측면 판별              정면=${fr.toFixed(2)} (>0.55) 측면=${sd.toFixed(2)} (<0.35)`);
r.push(okView);

console.log(r.every(Boolean) ? '\n전체 통과' : '\n실패 있음');
process.exit(r.every(Boolean) ? 0 : 1);
