// 計分規則的手算案例，以 docs/2026_rule_0903.pdf（9/3 版）為準。規則有疑義時，先改這裡的預期值，再改 scoring.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import { telScoring } from '../worker/scoring.js';

const scoring = telScoring();
const empty = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const grid = (cells) => Object.assign([...empty], cells);
const card = (cells, extra = {}) => ({ grid: grid(cells), lit: 0, hole: 0, miss: 0, yellow: 0, rescue: 3, seconds: 180, outcome: 'normal', ...extra });
const ranking = (c, target = '') => scoring.calculate(c, false, target);
const knockout = (c, target = '', multiplier = 1) => scoring.calculate(c, true, target, multiplier);

test('規則書 9/3 版 p.11 的官方範例與各項最高分', () => {
  // A 隊：中間橫排各 2 顆、中間直排上下各 1 顆 → 16 + 直線 4 + 橫線 2（只算一次）= 22
  assert.equal(knockout(card({ 1: 1, 3: 2, 4: 2, 5: 2, 7: 1 })).total, 22);
  // B 隊：左上 1、中央 1、下中 3（第 3 顆不計）、右下 1 → 10 + 斜線 8 = 18
  assert.equal(knockout(card({ 0: 1, 4: 1, 7: 3, 8: 1 })).total, 18);
  // 上半場：九宮格最高 54 分；亮燈小洞每顆 4 分，最多 3 顆（12 分）
  const all = (n) => Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, n]));
  assert.equal(ranking(card(all(3), { miss: 0 })).base, 54);
  assert.equal(ranking(card({}, { lit: 5 }), '1').total, 12, '亮燈小洞每顆 4 分，最多 3 顆');
  // 下半場：九宮格最高 36 分、亮燈小洞最多 8 分、連線最高 34 分 → 全場最高 78 分
  assert.deepEqual([knockout(card(all(2))).base, knockout(card(all(1))).connectionPoints], [36, 34]);
  assert.equal(knockout(card({}, { lit: 5 }), '1').total, 8, '亮燈小洞每顆 4 分，最多 2 顆');
  // 規則上限加總 78 分要 20 顆球，但下半場只有 18 顆：會被擋下；18 顆的實際最高是 74 分
  assert.match(knockout(card(all(2), { lit: 2 }), '1').error, /18/);
  assert.equal(knockout(card({ ...all(2), 7: 1, 8: 1 }, { lit: 2 }), '1').total, 32 + 8 + 34);
});

test('排名賽：每顆 2 分，每格上限 3 顆', () => {
  assert.equal(ranking(card({ 0: 3 })).total, 6);
  assert.equal(ranking(card({ 0: 5 })).total, 6, '超過 3 顆不再加分');
  assert.equal(ranking(card({ 0: 5 })).net, 5, '實際入網數仍完整記錄');
  assert.equal(ranking(card({ 0: 1, 4: 2, 8: 3 })).total, 12);
});

test('上方三個小洞（TEL 加分網框）獨立於九宮格之外', () => {
  // 亮燈小洞 1 顆 = 4 分，不佔九宮格任何一格的上限
  const r = ranking(card({ 0: 3 }, { lit: 1 }), '1');
  assert.deepEqual([r.base, r.bonus, r.total], [6, 4, 10]);
  // 進沒亮的小洞、或 60 秒後才進 → 不計分，但算實際入網數
  const unlit = ranking(card({}, { hole: 2 }), '1');
  assert.deepEqual([unlit.total, unlit.net], [0, 2]);
  // 小洞的球不參與連線：上排三格各 1 顆才有橫線，亮燈小洞不能補上
  const noLine = knockout(card({ 0: 1, 1: 1 }, { lit: 1 }), '2');
  assert.deepEqual([noLine.connectionPoints, noLine.total], [0, 4 + 4]);
  assert.equal(knockout(card({ 0: 1, 1: 1, 2: 1 }, { lit: 1 }), '2').connectionPoints, 2);
  // 舊資料沒有 hole 欄位，視為 0
  const { hole, ...legacy } = card({ 0: 1 });
  assert.equal(ranking(legacy).total, 2);
});

test('淘汰賽：每格上限 2 顆，並計連線分', () => {
  // 一列連線（格 1–3 各 2 顆）：基本 12 分；列連線每條 2 分、算 1 次，同分比較記 2 組。
  const row = knockout(card({ 0: 2, 1: 2, 2: 2 }));
  assert.equal(row.base, 12);
  assert.equal(row.connectionPoints, 2);
  assert.equal(row.connectionCount, 2);
  assert.equal(row.total, 14);
  // 全滿各 1 顆：對角 8×2 + 直行 4×3 + 橫列 2×3 = 34。
  const full = knockout(card({ 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 }));
  assert.equal(full.base, 18);
  assert.equal(full.connectionPoints, 34);
  assert.equal(full.total, 52);
  assert.equal(knockout(card({ 0: 4 })).total, 4, '淘汰賽每格上限 2 顆');
});

test('黃牌扣分、總分不低於 0；友誼賽取消排名加乘，附加賽第 5 名不 ×1.2', () => {
  assert.equal(knockout(card({ 0: 1 }, { yellow: 1 })).total, 1);
  assert.equal(ranking(card({ 0: 1 }, { yellow: 5 })).total, 0, '總分不會低於 0');
  const k1 = { id: 'K1', match: 'knockout', sideA: '第 4 名', sideB: '第 5 名', multiplier: '1.2',
    cardA: JSON.stringify(card({ 0: 2 })), cardB: JSON.stringify(card({ 0: 2 })) };
  assert.equal(scoring.scoreSide(k1, 'A').total, 4);
  assert.equal(scoring.scoreSide(k1, 'B').total, 4, '舊資料留下的 ×1.2 也忽略');
});

test('裁判判決：0 分、紅牌失格、淘汰賽放棄卡', () => {
  assert.equal(ranking(card({ 0: 3 }, { outcome: 'zero' })).total, 0);
  const dq = ranking(card({ 0: 3 }, { outcome: 'dq' }));
  assert.equal(dq.total, 0);
  assert.equal(dq.blocked, true);
  const absent = ranking(card({}, { outcome: 'absent' }));
  assert.deepEqual([absent.total, absent.blocked], [0, true], '未出賽比照失格排最後');
  assert.equal(scoring.compare(ranking(card({})), absent) > 0, true, '0 分出賽仍排在未出賽之前');
  assert.equal(knockout(card({ 0: 2 }, { outcome: 'withdraw' })).blocked, true);
  const rankingWithdraw = ranking(card({ 0: 3 }, { outcome: 'withdraw' }));
  assert.equal(rankingWithdraw.blocked, false, '排名賽放棄卡保留已得分數');
  assert.equal(rankingWithdraw.total, 6);
});

test('輸入檢查', () => {
  assert.match(ranking(card({ 0: 20 }, { miss: 10 })).error, /27/);
  assert.match(knockout(card({ 0: 10 }, { miss: 9 })).error, /18/);
  assert.match(ranking(card({ 0: 20 }, { lit: 3, hole: 3, miss: 2 })).error, /27/, '小洞的球也算進總球數');
  assert.ok(ranking(card({}, { hole: -1 })).error);
  assert.ok(ranking({ ...card({}), rescue: 4 }).error);
  assert.ok(ranking({ ...card({}), grid: [1, 2] }).error);
  assert.equal(scoring.calculate(null, false, ''), null);
});

test('同分比較順序', () => {
  const a = ranking(card({}, { lit: 1 }), '1'); // 4 分，命中亮燈小洞
  const b = ranking(card({ 3: 2 })); // 4 分，未命中
  assert.equal(a.total, b.total);
  assert.ok(scoring.compare(a, b) > 0, '先比亮燈小洞命中');
  const spread = ranking(card({ 0: 1, 1: 1 })); // 4 分，命中 2 個網框
  const stacked = ranking(card({ 0: 2 })); // 4 分，命中 1 個網框
  assert.ok(scoring.compare(spread, stacked) > 0, '再比命中不同網框數');
  const fast = ranking(card({ 0: 2 }, { seconds: 100 }));
  const slow = ranking(card({ 0: 2 }, { seconds: 150 }));
  assert.ok(scoring.compare(fast, slow) > 0, '排名賽最後比耗時，越快越好');
  const dq = ranking(card({ 0: 3 }, { outcome: 'dq' }));
  assert.ok(scoring.compare(slow, dq) > 0, '失格一律排在後面');
  assert.equal(scoring.compare(fast, fast), 0);
});
