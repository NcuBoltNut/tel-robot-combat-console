// /api/state 的欄位層級合併、衝突與伺服器端規則檢查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { d1 } from '../d1.mjs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const origin = 'http://127.0.0.1:3000';
const card = (cells, extra = {}) => JSON.stringify({ grid: Object.assign([0, 0, 0, 0, 0, 0, 0, 0, 0], cells), lit: 0, miss: 0, yellow: 0, rescue: 3, seconds: 180, outcome: 'normal', ...extra });

function setup({ loseRaces = 0 } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  let races = loseRaces;
  const real = d1(db);
  // 模擬另一個 Worker 執行個體搶先寫入：主表寫入失敗，伺服器要重讀再合併。
  const DB = {
    prepare(sql) {
      const statement = real.prepare(sql);
      if (!sql.startsWith('INSERT INTO tel_console')) return statement;
      return { ...statement, bind: (...args) => ({ run: () => (races > 0 ? (races--, { meta: { changes: 0 } }) : statement.bind(...args).run()) }) };
    },
  };
  const env = (name, role = 'referee') => ({ DB, viewer: { name, remote: true, role } });
  return {
    async get(since) {
      const res = await worker.fetch(new Request(origin + '/api/state' + (since === undefined ? '' : '?since=' + since)), env('x'));
      return { status: res.status, data: res.status === 204 ? null : await res.json() };
    },
    DB,
    raw: (path) => worker.fetch(new Request(origin + path), env('x')),
    async put(name, body, headers = {}, role = 'referee') {
      const res = await worker.fetch(new Request(origin + '/api/state', {
        method: 'PUT', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      }), env(name, role));
      return { status: res.status, data: await res.json() };
    },
  };
}
const find = (data, id) => data.records.find((r) => r.id === id);
const edit = (id, type, changes, base = {}) => ({ id, type, changes, base });

test('沒有變動時以 204 回應輪詢', async () => {
  const api = setup();
  const first = await api.get();
  assert.equal(first.status, 200);
  assert.equal(first.data.revision, 0);
  assert.equal((await api.get(0)).status, 204);
  await api.put('場控', edit('S01', 'schedule', { actual: '10:05' }));
  assert.equal((await api.get(0)).status, 200);
  assert.equal((await api.get(1)).status, 204);
});

test('兩人同時改同一筆的不同欄位：兩邊都保留', async () => {
  const api = setup();
  const a = await api.put('場控', edit('S03', 'schedule', { status: '進行中' }, { status: '未開始' }));
  const b = await api.put('主裁判', edit('S03', 'schedule', { actual: '12:03' }, { actual: '' }));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const record = find(b.data, 'S03');
  assert.equal(record.status, '進行中');
  assert.equal(record.actual, '12:03');
  assert.equal(record.editedBy, '主裁判');
  assert.equal(b.data.revision, 2);
});

test('同一欄位被別人改過：回 409 並列出欄位，確認後可覆蓋', async () => {
  const api = setup();
  const seedNotes = find((await api.get()).data, 'S03').notes;
  await api.put('場控', edit('S03', 'schedule', { notes: '改成 12:05 開始' }, { notes: seedNotes }));
  const late = await api.put('主裁判', edit('S03', 'schedule', { notes: '延後五分鐘', actual: '12:05' }, { notes: seedNotes, actual: '' }));
  assert.equal(late.status, 409);
  assert.deepEqual(late.data.conflicts, ['notes']);
  assert.equal(late.data.current.notes, '改成 12:05 開始');
  assert.equal(late.data.current.editedBy, '場控');
  assert.equal(find(late.data.state, 'S03').actual, undefined, '衝突時整筆都不寫入');
  const retry = await api.put('主裁判', edit('S03', 'schedule', { notes: '延後五分鐘', actual: '12:05' }, { notes: '改成 12:05 開始', actual: '' }));
  assert.equal(retry.status, 200);
  assert.equal(find(retry.data, 'S03').notes, '延後五分鐘');
});

test('兩人把同一欄位改成相同的值不算衝突', async () => {
  const api = setup();
  await api.put('計分 A', edit('S04', 'schedule', { status: '已完成' }, { status: '未開始' }));
  assert.equal((await api.put('計分 B', edit('S04', 'schedule', { status: '已完成' }, { status: '未開始' }))).status, 200);
});

test('寫入時剛好被搶先：重新讀取後合併，不會蓋掉別人的資料', async () => {
  const api = setup({ loseRaces: 2 });
  const result = await api.put('場控', edit('S05', 'schedule', { actual: '12:20' }));
  assert.equal(result.status, 200);
  assert.equal(find(result.data, 'S05').actual, '12:20');
});

test('不接受修改受保護欄位或錯誤格式', async () => {
  const api = setup();
  assert.equal((await api.put('x', edit('S01', 'schedule', { match: 'ranking' }))).status, 400);
  assert.equal((await api.put('x', edit('S01', 'schedule', { editedBy: '別人' }))).status, 400);
  assert.equal((await api.put('x', edit('S01', 'team', { notes: 'x' }))).status, 400, '類型不符');
  assert.equal((await api.put('x', edit('S01', 'schedule', { status: '亂寫' }, { status: '未開始' }))).status, 400);
  assert.equal((await api.put('x', edit('S01', 'schedule', { notes: 3 }))).status, 400);
  assert.equal((await api.put('x', edit('S01', 'schedule', { title: ' ' }, { title: '工作人員集合與分工' }))).status, 400);
  assert.equal((await api.put('x', edit('nope', 'schedule', { notes: 'x' }))).status, 409, '找不到紀錄');
  assert.equal((await api.put('x', edit('S01', 'schedule', { notes: 'x' }), { origin: 'https://evil.example' })).status, 403);
});

test('新增紀錄', async () => {
  const api = setup();
  const created = await api.put('攝影', { id: 'm-1', type: 'media', isNew: true, changes: { title: '冠軍賽影片', status: '待確認', url: 'https://example.com/v' } });
  assert.equal(created.status, 200);
  assert.equal(find(created.data, 'm-1').editedBy, '攝影');
  assert.equal((await api.put('攝影', { id: 'm-1', type: 'media', isNew: true, changes: { title: 'x', status: '待確認' } })).status, 409, '編號重複');
  assert.equal((await api.put('攝影', { id: 'm-2', type: 'media', isNew: true, changes: { title: 'x', status: '待確認', url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await api.put('x', { id: 't-9', type: 'team', isNew: true, changes: { title: '中央 A', status: '待確認' } })).status, 400, '同名隊伍');
});

test('既有五隊不可改名', async () => {
  const api = setup();
  const res = await api.put('x', edit('T0', 'team', { title: '中央 Z' }, { title: '中央 A' }));
  assert.equal(res.status, 400);
  assert.match(res.data.error, /隊別名稱/);
});

test('伺服器依計分明細重算得分，忽略前端送來的分數', async () => {
  const api = setup();
  const res = await api.put('計分 A', edit('R1', 'schedule', { cardA: card({ 0: 3 }), scoreA: '999' }));
  assert.equal(res.status, 200);
  assert.equal(find(res.data, 'R1').scoreA, '6');
  const bad = await api.put('計分 A', edit('R2', 'schedule', { cardA: card({ 0: 30 }) }));
  assert.equal(bad.status, 400);
});

async function confirmRankings(api) {
  const teams = ['中央 A', '中央 B', '元智 A', '元智 B', '中原 A'];
  for (let i = 0; i < 5; i++) {
    const res = await api.put('主裁判', edit('R' + (i + 1), 'schedule', { cardA: card({ 0: 3, 1: 5 - i }), rank: String(i + 1), resultStatus: '已確認', signoff: '主裁' }));
    assert.equal(res.status, 200, teams[i] + '：' + JSON.stringify(res.data.error));
  }
}

test('亮燈小洞與首輪加乘只接受規則內的值，小洞分數有算進去', async () => {
  const api = setup();
  const bad = await api.put('x', edit('R1', 'schedule', { cardA: card({ 0: 2 }), target: '上排 左' }));
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /亮燈小洞/);
  assert.equal((await api.put('x', edit('K1', 'schedule', { multiplier: '採 09/03 正賽規則 ×1.2' }))).status, 400);
  const lit = await api.put('x', edit('R1', 'schedule', { cardA: card({ 0: 2 }, { lit: 1 }), target: '1' }));
  assert.equal(lit.status, 200);
  assert.equal(find(lit.data, 'R1').scoreA, '8', '九宮格 2 顆 ×2 分 + 亮燈小洞 1 顆 4 分');
});

test('排名確認：缺簽認或名次重複會被擋下', async () => {
  const api = setup();
  const noSign = await api.put('x', edit('R1', 'schedule', { cardA: card({ 0: 3 }), rank: '1', resultStatus: '已確認' }));
  assert.equal(noSign.status, 400);
  await api.put('x', edit('R1', 'schedule', { cardA: card({ 0: 3 }), rank: '1', resultStatus: '已確認', signoff: '主裁' }));
  const dup = await api.put('x', edit('R2', 'schedule', { cardA: card({ 0: 2 }), rank: '1', resultStatus: '已確認', signoff: '主裁' }));
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /排名/);
});

test('五場排名賽都確認後，空白名次依計分自動帶入', async () => {
  const api = setup();
  // R3 最高、R1 最低；名次全部留白。
  const cells = { R1: { 0: 1 }, R2: { 0: 2 }, R3: { 0: 3, 1: 3 }, R4: { 0: 3 }, R5: { 0: 3, 1: 1 } };
  let res;
  for (const id of ['R1', 'R2', 'R3', 'R4']) {
    res = await api.put('主裁判', edit(id, 'schedule', { cardA: card(cells[id]), resultStatus: '已確認', signoff: '主裁' }));
    assert.equal(res.status, 200, JSON.stringify(res.data.error));
    assert.equal(find(res.data, 'R1').rank ?? '', '', '還沒五場都確認前不帶入');
  }
  res = await api.put('主裁判', edit('R5', 'schedule', { cardA: card(cells.R5), resultStatus: '已確認', signoff: '主裁' }));
  assert.equal(res.status, 200);
  assert.deepEqual(['R1', 'R2', 'R3', 'R4', 'R5'].map((id) => find(res.data, id).rank), ['5', '4', '1', '3', '2']);
  assert.equal(find(res.data, 'R3').editedBy, '自動排名（依計分）');
  assert.equal(find(res.data, 'R5').editedBy, '主裁判', '自己這場仍記在確認的人名下');
  const history = await api.DB.prepare("SELECT by, role, after FROM history WHERE record_id = 'R3' AND field = 'rank'").all();
  assert.deepEqual(history.results.map((h) => [h.by, h.role, h.after]), [['自動排名（依計分）', 'system', '1']]);
});

test('自動名次：完全同分留白給主裁，已手動填的名次不重複使用', async () => {
  const api = setup();
  const cells = { R1: { 0: 1 }, R2: { 0: 2 }, R3: { 0: 2 }, R4: { 0: 3 }, R5: { 0: 3, 1: 1 } };
  let res;
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5']) {
    const rank = id === 'R1' ? { rank: '5' } : {};
    res = await api.put('主裁判', edit(id, 'schedule', { cardA: card(cells[id]), ...rank, resultStatus: '已確認', signoff: '主裁' }));
    assert.equal(res.status, 200, JSON.stringify(res.data.error));
  }
  assert.deepEqual(['R1', 'R2', 'R3', 'R4', 'R5'].map((id) => find(res.data, id).rank ?? ''), ['5', '', '', '2', '1']);
  const drawn = await api.put('主裁判', edit('R2', 'schedule', { rank: '3', scoreNotes: '主裁抽籤' }));
  assert.equal(drawn.status, 200);
  assert.equal(find(drawn.data, 'R3').rank ?? '', '', '同分的另一隊仍由主裁填寫');
});

test('一隊未出賽：自動改四隊賽制，不舉行附加賽，準決賽 A 為第 1 名 vs. 第 4 名', async () => {
  const api = setup();
  // 中原 A（R5）未出賽；其餘四隊依分數排 1–4。
  const cells = { R1: { 0: 3, 4: 2 }, R2: { 0: 3, 1: 3, 4: 1 }, R3: { 0: 2 }, R4: { 0: 3, 1: 3, 2: 3, 4: 3 } };
  for (const [id, g] of Object.entries(cells)) assert.equal((await api.put('主裁判', edit(id, 'schedule', { cardA: card(g), resultStatus: '已確認', signoff: '主裁' }))).status, 200);
  const absent = await api.put('主裁判', edit('R5', 'schedule', { cardA: card({}, { outcome: 'absent' }), resultStatus: '已確認', signoff: '主裁', scoreNotes: '未到場' }));
  assert.equal(absent.status, 200, JSON.stringify(absent.data.error));
  assert.deepEqual(['R4', 'R2', 'R1', 'R3', 'R5'].map((id) => find(absent.data, id).rank), ['1', '2', '3', '4', '5'], '未出賽排最後');
  const k1 = await api.put('主裁判', edit('K1', 'schedule', { cardA: card({ 0: 1 }), cardB: card({}), resultStatus: '已確認', signoff: '主裁' }));
  assert.equal(k1.status, 400);
  assert.match(k1.data.error, /四隊賽制/);
  const play = async (id, a, b) => {
    const res = await api.put('主裁判', edit(id, 'schedule', { cardA: card(a), cardB: card(b), resultStatus: '已確認', signoff: '主裁' }));
    assert.equal(res.status, 200, id + '：' + JSON.stringify(res.data.error));
    return find(res.data, id);
  };
  const k2 = await play('K2', { 0: 1 }, { 0: 2 });
  assert.deepEqual([k2.scoredTeamA, k2.scoredTeamB, k2.winner], ['元智 B', '元智 A', '元智 A'], '第 1 名 vs. 第 4 名');
  const k3 = await play('K3', { 0: 2 }, { 0: 1 });
  assert.deepEqual([k3.scoredTeamA, k3.scoredTeamB, k3.winner], ['中央 B', '中央 A', '中央 B'], '第 2 名 vs. 第 3 名');
  const k4 = await play('K4', { 0: 2 }, { 0: 1 });
  assert.deepEqual([k4.scoredTeamA, k4.scoredTeamB, k4.winner], ['元智 A', '中央 B', '元智 A']);
  const pub = JSON.parse(await (await api.raw('/api/public')).text());
  const pk1 = pub.knockout.find((m) => m.id === 'K1');
  assert.deepEqual([pk1.skipped, pk1.state, pk1.teamA, pk1.teamB], [true, '不舉行', '', '']);
  assert.equal(pub.knockout.find((m) => m.id === 'K2').slotB, '第 4 名');
  assert.equal(pub.champion, '元智 A');
});

test('紅牌／失格／缺席不會觸發四隊賽制，仍排第 5 名進附加賽', async () => {
  const api = setup();
  for (const id of ['R1', 'R2', 'R3', 'R4']) await api.put('主裁判', edit(id, 'schedule', { cardA: card({ 0: Number(id[1]) }), resultStatus: '已確認', signoff: '主裁' }));
  await api.put('主裁判', edit('R5', 'schedule', { cardA: card({}, { outcome: 'dq' }), resultStatus: '已確認', signoff: '主裁' }));
  const pub = JSON.parse(await (await api.raw('/api/public')).text());
  assert.equal(pub.knockout.find((m) => m.id === 'K1').skipped, false);
  assert.equal(pub.knockout.find((m) => m.id === 'K1').teamB, '中原 A', '失格方仍排第 5 名、進附加賽');
});

test('活動文字集中在 worker/event.js：控制台、觀賽、字卡都讀它', async () => {
  const { event } = await import('../worker/event.js');
  const api = setup();
  const page = await (await api.raw('/')).text();
  assert.ok(page.includes(event.title) && page.includes(event.organizer), '控制台首頁');
  assert.ok((await (await api.raw('/watch')).text()).includes(event.brand), '觀賽畫面');
  assert.ok((await (await api.raw('/overlay.js')).text()).includes(JSON.stringify(event.overlayRight)), '直播字卡');
});

test('攝影通行碼：首頁就是滿版直播字卡，只能讀公開資料，不能進控制台或修改', async () => {
  const api = setup();
  const env = { DB: api.DB, viewer: { name: '攝影', remote: true, role: 'camera' } };
  const go = (path, init) => worker.fetch(new Request('http://127.0.0.1:3000' + path, init), env);
  const home = await go('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /直播字卡[\s\S]*overlay\.js/);
  for (const path of ['/overlay', '/overlay.js', '/overlay.css', '/api/public', '/watch']) assert.equal((await go(path)).status, 200, path);
  assert.equal((await go('/api/state')).status, 403);
  assert.equal((await go('/app.js')).status, 403);
  const put = await go('/api/state', { method: 'PUT', headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: JSON.stringify(edit('S01', 'schedule', { notes: 'x' })) });
  assert.equal(put.status, 403);
});

test('淘汰賽：兩位計分員同時登錄雙方，再由主裁確認', async () => {
  const api = setup();
  await confirmRankings(api);
  // K1 = 第 4 名（元智 B）vs. 第 5 名（中原 A）
  const a = await api.put('計分 A', edit('K1', 'schedule', { cardA: card({ 0: 2, 1: 2, 2: 2 }), multiplier: '1' }));
  const b = await api.put('計分 B', edit('K1', 'schedule', { cardB: card({ 0: 2 }), multiplier: '1' }));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  let k1 = find(b.data, 'K1');
  assert.equal(k1.scoreA, '14');
  assert.equal(k1.scoreB, '4');
  assert.equal(k1.scoredTeamA, '元智 B');
  assert.equal(k1.scoredTeamB, '中原 A');

  const wrong = await api.put('主裁判', edit('K1', 'schedule', { resultStatus: '已確認', signoff: '主裁', winner: '中原 A' }));
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /勝者/);
  const ok = await api.put('主裁判', edit('K1', 'schedule', { resultStatus: '已確認', signoff: '主裁' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.data.error));
  k1 = find(ok.data, 'K1');
  assert.equal(k1.winner, '元智 B', '依計分自動帶入勝者');
  // 勝者帶入準決賽 A 的 B 方
  const k2 = await api.put('計分 A', edit('K2', 'schedule', { cardA: card({ 0: 1 }), cardB: card({ 0: 2 }) }));
  assert.equal(find(k2.data, 'K2').scoredTeamA, '中央 A');
  assert.equal(find(k2.data, 'K2').scoredTeamB, '元智 B');
});

test('K1 不必選加乘就能確認；只有一方明細不能確認', async () => {
  const api = setup();
  await confirmRankings(api);
  const k1 = await api.put('x', edit('K1', 'schedule', { cardA: card({ 0: 2 }), cardB: card({ 0: 1 }), resultStatus: '已確認', signoff: '主裁' }));
  assert.equal(k1.status, 200, JSON.stringify(k1.data.error));
  assert.equal(find(k1.data, 'K1').scoreB, '2', '第 5 名不加乘');
  const oneSide = await api.put('x', edit('K3', 'schedule', { cardA: card({ 0: 2 }), resultStatus: '已確認', signoff: '主裁' }));
  assert.match(oneSide.data.error, /兩隊/);
  const tie = await api.put('x', edit('K3', 'schedule', { cardA: card({ 0: 2 }), cardB: card({ 0: 2 }), resultStatus: '已確認', signoff: '主裁', winner: '中央 B' }));
  assert.match(tie.data.error, /抽籤/, '完全同分要記錄抽籤結果');
  const drawn = await api.put('x', edit('K3', 'schedule', { cardA: card({ 0: 2 }), cardB: card({ 0: 2 }), resultStatus: '已確認', signoff: '主裁', winner: '中央 B', scoreNotes: '同分，主裁抽籤' }));
  assert.equal(drawn.status, 200, JSON.stringify(drawn.data.error));
});

test('隊伍異動後，只改備註仍可儲存', async () => {
  const api = setup();
  await confirmRankings(api);
  await api.put('x', edit('K1', 'schedule', { cardA: card({ 0: 2 }), cardB: card({ 0: 1 }), multiplier: '1', resultStatus: '已確認', signoff: '主裁' }));
  // 第 5 名改判給別隊 → K1 的已確認成績需要重新複核
  await api.put('x', edit('R5', 'schedule', { resultStatus: '進行中' }, { resultStatus: '已確認' }));
  const notes = await api.put('x', edit('K1', 'schedule', { checkIn: '雙方急停正常' }));
  assert.equal(notes.status, 200, JSON.stringify(notes.data.error));
});

test('/app.js 可以解析，且共用規則已注入', async () => {
  const res = await worker.fetch(new Request(origin + '/app.js'), {});
  const text = await res.text();
  assert.doesNotThrow(() => new Function(text));
  assert.match(text, /telRules|prepare/);
  const page = await worker.fetch(new Request(origin + '/'), {});
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('權限：檢視不能改；計分可以登錄明細，但確認成績要主裁判', async () => {
  const api = setup();
  const asRole = (role, body) => api.put(role, body, {}, role);
  const viewOnly = await asRole('view', edit('S01', 'schedule', { actual: '10:01' }));
  assert.equal(viewOnly.status, 403);
  assert.match(viewOnly.data.error, /檢視/);

  assert.equal((await asRole('edit', edit('S01', 'schedule', { actual: '10:01' }))).status, 200, '計分可以改一般欄位');
  assert.equal((await asRole('edit', edit('R1', 'schedule', { cardA: card({ 0: 3 }), resultStatus: '進行中' }))).status, 200, '計分可以登錄明細');
  const confirm = await asRole('edit', edit('R1', 'schedule', { resultStatus: '已確認', signoff: '主裁', rank: '1' }, { resultStatus: '進行中' }));
  assert.equal(confirm.status, 403);
  assert.match(confirm.data.error, /主裁判/);
  assert.equal((await asRole('referee', edit('R1', 'schedule', { resultStatus: '已確認', signoff: '主裁', rank: '1' }, { resultStatus: '進行中' }))).status, 200);

  const tamper = await asRole('edit', edit('R1', 'schedule', { cardA: card({ 0: 1 }) }, { cardA: card({ 0: 3 }) }));
  assert.equal(tamper.status, 403, '計分不能改已確認的明細');
  const undo = await asRole('edit', edit('R1', 'schedule', { resultStatus: '進行中' }, { resultStatus: '已確認' }));
  assert.equal(undo.status, 403, '計分不能撤回確認');
  assert.equal((await asRole('edit', edit('R1', 'schedule', { checkIn: '急停正常' }))).status, 200, '已確認場次的檢錄欄位仍可填寫');
});

test('真正的並發：30 個寫入同時送出，全部成功且沒有遺失', async () => {
  const api = setup();
  const ids = ['S00', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14'];
  const results = await Promise.all(ids.flatMap((id, i) => [
    api.put('計分 A', edit(id, 'schedule', { actual: 'A' + i })),
    api.put('計分 B', edit(id, 'schedule', { checkIn: 'B' + i })),
  ]));
  assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
  const { data } = await api.get();
  assert.equal(data.revision, 30);
  ids.forEach((id, i) => {
    assert.equal(find(data, id).actual, 'A' + i);
    assert.equal(find(data, id).checkIn, 'B' + i);
  });
});

test('完整賽程：排名賽 → 附加賽 → 準決賽 → 冠軍賽', async () => {
  const api = setup();
  await confirmRankings(api); // 1 中央 A、2 中央 B、3 元智 A、4 元智 B、5 中原 A
  const play = async (id, a, b, extra = {}) => {
    const res = await api.put('主裁判', edit(id, 'schedule', { cardA: card(a), cardB: card(b), resultStatus: '已確認', signoff: '主裁', ...extra }));
    assert.equal(res.status, 200, id + '：' + JSON.stringify(res.data.error));
    return find(res.data, id);
  };
  const k1 = await play('K1', { 0: 1 }, { 0: 2 }, { multiplier: '1.2' });
  assert.deepEqual([k1.scoredTeamA, k1.scoredTeamB, k1.scoreB, k1.winner], ['元智 B', '中原 A', '4', '中原 A'], '舊資料的 ×1.2 不再生效');
  const k2 = await play('K2', { 0: 1 }, { 0: 2 });
  assert.deepEqual([k2.scoredTeamA, k2.scoredTeamB, k2.winner], ['中央 A', '中原 A', '中原 A'], '附加賽勝者帶入準決賽 A');
  const k3 = await play('K3', { 0: 2, 1: 2, 2: 2 }, { 0: 2 });
  assert.deepEqual([k3.scoredTeamA, k3.scoredTeamB, k3.winner], ['中央 B', '元智 A', '中央 B']);
  const k4 = await play('K4', { 0: 1 }, { 4: 2 });
  assert.deepEqual([k4.scoredTeamA, k4.scoredTeamB, k4.winner], ['中原 A', '中央 B', '中央 B'], '冠軍賽由兩場準決賽勝者對戰');

  // 主裁判撤回 K1 → 下游的準決賽 A、冠軍賽都回到待確認
  const undo = await api.put('主裁判', edit('K1', 'schedule', { resultStatus: '進行中' }, { resultStatus: '已確認' }));
  const csv = await (await api.raw('/api/export.csv')).text();
  assert.equal(undo.status, 200);
  assert.match(csv.split('\r\n').find((line) => line.startsWith('K2,')), /,待確認,/);
  assert.match(csv.split('\r\n').find((line) => line.startsWith('K4,')), /,待確認,/);
});

test('重送新增：內容相同視為成功，不同內容仍擋下', async () => {
  const api = setup();
  const create = { id: 'media-retry', type: 'media', isNew: true, changes: { title: '冠軍賽影片', status: '待確認' } };
  assert.equal((await api.put('攝影', create)).status, 200);
  const retry = await api.put('攝影', create);
  assert.equal(retry.status, 200, '回應遺失後重送');
  assert.equal(retry.data.records.filter((r) => r.id === 'media-retry').length, 1, '不會產生重複紀錄');
  assert.equal((await api.put('攝影', { ...create, changes: { title: '別的影片', status: '待確認' } })).status, 409);
});

test('修改歷史：記錄每個欄位的前後值、修改者與權限', async () => {
  const api = setup();
  await api.put('計分 A', edit('R1', 'schedule', { cardA: card({ 0: 3 }) }), {}, 'edit');
  await api.put('主裁判', edit('R1', 'schedule', { cardA: card({ 0: 2 }), rank: '1', resultStatus: '已確認', signoff: '主裁' }, { cardA: card({ 0: 3 }) }));
  const { history } = await (await api.raw('/api/history?id=R1')).json();
  const scoreChanges = history.filter((h) => h.field === 'scoreA').map((h) => [h.before, h.after, h.by, h.role]);
  assert.deepEqual(scoreChanges, [['6', '4', '主裁判', 'referee'], ['', '6', '計分 A', 'edit']], '最新在前');
  assert.ok(history.some((h) => h.field === 'resultStatus' && h.after === '已確認'));
  assert.ok(!history.some((h) => h.field === 'editedAt'), '不記錄修改時間欄位本身');
  assert.equal((await api.raw('/api/history?id=../x')).status, 400);
});

test('CSV 匯出：Excel 可開的 UTF-8、防公式注入', async () => {
  const api = setup();
  await api.put('主裁判', edit('R1', 'schedule', { cardA: card({ 0: 3 }), rank: '1', resultStatus: '已確認', signoff: '=HYPERLINK("x")', scoreNotes: '第一行\n"引號"' }));
  const res = await api.raw('/api/export.csv');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  // Response.text() 解碼時會去掉 BOM，所以直接檢查位元組。
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 讓 Excel 正確顯示中文');
  const text = bytes.subarray(3).toString('utf8');
  assert.match(text, /^場次編號,場次,/);
  assert.ok(text.includes(`'=HYPERLINK(""x"")`), '公式前加單引號');
  assert.ok(text.includes('"第一行\n""引號"""'), '換行與引號正確跳脫');
  assert.equal(text.trim().split('\r\n').length, 1 + 9, '標題列＋9 場');
});

test('名次與分數矛盾：需要在備註記錄裁決依據', async () => {
  const api = setup();
  await api.put('主裁判', edit('R2', 'schedule', { cardA: card({ 0: 3, 1: 3 }), rank: '2', resultStatus: '已確認', signoff: '主裁' }));
  const contradict = await api.put('主裁判', edit('R1', 'schedule', { cardA: card({ 0: 1 }), rank: '1', resultStatus: '已確認', signoff: '主裁' }));
  assert.equal(contradict.status, 400);
  assert.match(contradict.data.error, /計分順序不符.*中央 B/);
  const ruled = await api.put('主裁判', edit('R1', 'schedule', { cardA: card({ 0: 1 }), rank: '1', resultStatus: '已確認', signoff: '主裁', scoreNotes: '中央 B 違規，主裁改判' }));
  assert.equal(ruled.status, 200);
});

test('觀賽資料：檢視身分只拿得到公開資料；計分明細與暫定分數公開，聯絡方式、簽認、備註不外流', async () => {
  const api = setup();
  const asViewer = (path) => worker.fetch(new Request(origin + path), { DB: api.DB, viewer: { name: '觀摩', remote: true, role: 'view' } });
  await api.put('x', edit('T0', 'team', { contactInfo: '0912-345-678', contact: '王隊長' }));
  await api.put('x', edit('P1', 'staff', { contactInfo: 'judge@example.com' }));
  await confirmRankings(api); // R1–R5 已確認
  await api.put('計分 A', edit('K1', 'schedule', { cardA: card({ 0: 2 }), cardB: card({ 0: 1 }), resultStatus: '進行中', status: '進行中' }, { status: '未開始' }));

  for (const path of ['/api/state', '/api/history?id=R1', '/api/export.csv', '/app.js']) assert.equal((await asViewer(path)).status, 403, path);
  const page = await asViewer('/');
  assert.match(await page.text(), /watch\.js/, '檢視身分的首頁是觀賽畫面');

  const res = await asViewer('/api/public');
  assert.equal(res.status, 200);
  const raw = await res.clone().text();
  for (const secret of ['0912-345-678', 'judge@example.com', '王隊長', 'signoff', '主裁', 'scoreNotes', 'editedBy']) assert.ok(!raw.includes(secret), '不應包含：' + secret);
  const data = await res.json();
  assert.deepEqual(data.ranking.map((m) => [m.rank, m.teamA, m.state]), [['1', '中央 A', '已公布'], ['2', '中央 B', '已公布'], ['3', '元智 A', '已公布'], ['4', '元智 B', '已公布'], ['5', '中原 A', '已公布']]);
  assert.equal(data.ranking[0].scoreA, '12');
  const k1 = data.knockout.find((m) => m.id === 'K1');
  assert.deepEqual([k1.teamA, k1.teamB, k1.state, k1.scoreA, k1.scoreB, k1.winner, k1.provisional], ['元智 B', '中原 A', '比賽中', '4', '2', '', true], '比賽中顯示暫定分數，勝者要確認後才公布');
  assert.deepEqual([k1.cardA.grid, k1.cardA.base, k1.cardA.connectionPoints, k1.cardB.total], [[2, 0, 0, 0, 0, 0, 0, 0, 0], 4, 0, 2], '計分明細公開');
  assert.equal(k1.cardA.seconds, undefined);
  const k2 = data.knockout.find((m) => m.id === 'K2');
  assert.deepEqual([k2.teamA, k2.teamB, k2.slotB], ['中央 A', '', '附加賽勝者'], '未決定的席位顯示來源');
  assert.equal(data.champion, '');
  assert.ok(data.events.some((e) => e.id === 'K1' && e.status === '比賽中'));
  assert.equal(data.teams.length, 5);
  assert.equal((await worker.fetch(new Request(origin + '/api/public?since=' + data.revision), { DB: api.DB })).status, 204);

  await api.put('主裁判', edit('K1', 'schedule', { resultStatus: '已確認', signoff: '主裁', multiplier: '1', status: '已完成' }, { resultStatus: '進行中', status: '進行中' }));
  const after = await (await asViewer('/api/public')).json();
  const k1done = after.knockout.find((m) => m.id === 'K1');
  assert.deepEqual([k1done.state, k1done.scoreA, k1done.scoreB, k1done.winner, k1done.provisional], ['已公布', '4', '2', '元智 B', false]);
  assert.equal(after.knockout.find((m) => m.id === 'K2').teamB, '元智 B');
});

test('主審移除場次：從賽程、觀賽、CSV 與計時選單消失，名次以剩下的場次帶入，可以復原', async () => {
  const api = setup();
  const as = (role) => ({ DB: api.DB, viewer: { name: role === 'referee' ? '主裁判' : '計分員', remote: true, role } });
  const putAs = async (role, id, changes, base = {}) => {
    const res = await worker.fetch(new Request(origin + '/api/state', { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(edit(id, 'schedule', changes, base)) }), as(role));
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await putAs('edit', 'R5', { removed: '1' })).status, 403, '計分員不能移除場次');
  assert.equal((await putAs('referee', 'S01', { removed: '1' })).status, 400, '一般流程不能用移除');
  assert.equal((await putAs('referee', 'R5', { removed: 'x' })).status, 400);
  const gone = await putAs('referee', 'R5', { removed: '1' });
  assert.equal(gone.status, 200, JSON.stringify(gone.data.error));
  const pub = JSON.parse(await (await api.raw('/api/public')).text());
  assert.equal(pub.ranking.some((m) => m.id === 'R5'), false, '觀賽畫面不列移除的場次');
  assert.equal(pub.events.some((e) => e.id === 'R5'), false);
  const timer = await worker.fetch(new Request(origin + '/api/timer', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'field', matchId: 'R5' }) }), as('referee'));
  assert.equal(timer.status, 400, '移除的場次不能指定上場');
  // 剩下四場排名賽確認後，名次 1–4 自動帶入
  const cells = { R1: { 0: 1 }, R2: { 0: 2 }, R3: { 0: 3 }, R4: { 0: 3, 1: 1 } };
  let res;
  for (const [id, g] of Object.entries(cells)) res = await putAs('referee', id, { cardA: card(g), resultStatus: '已確認', signoff: '主裁' });
  assert.deepEqual(['R1', 'R2', 'R3', 'R4'].map((id) => find(res.data, id).rank), ['4', '3', '2', '1']);
  const csv = await (await api.raw('/api/export.csv')).text();
  assert.equal(/中原 A 單隊計分/.test(csv), false, 'CSV 不含移除的場次');
  const back = await putAs('referee', 'R5', { removed: '' }, { removed: '1' });
  assert.equal(back.status, 200);
  assert.equal(JSON.parse(await (await api.raw('/api/public')).text()).ranking.some((m) => m.id === 'R5'), true, '復原後回到賽程');
  const history = await api.DB.prepare("SELECT before, after, by FROM history WHERE record_id = 'R5' AND field = 'removed'").all();
  assert.deepEqual(history.results.map((h) => [h.after, h.by]), [['1', '主裁判'], ['', '主裁判']], '移除與復原都記在修改歷史');
});

test('比賽音效：開始、第 60 秒手動、剩 30 秒、結束各觸發一次；中途打開不補播', async () => {
  const { telTimer } = await import('../worker/timer.js');
  const cue = telTimer().cueTracker();
  const t = { mode: 'match', matchId: 'R1', duration: 180, finished: false };
  const seq = [0, 500, 30000, 59900, 60100, 120000, 149900, 150100, 179900, 180000, 180000].map((ms) => cue(t, ms)).filter(Boolean);
  assert.deepEqual(seq, ['start', 'resume', 'warning', 'end']);
  const late = telTimer().cueTracker();
  assert.equal(late(t, 90000), null, '比賽進行到一半才打開畫面，不補播開始音效');
  assert.equal(late(t, 150500), 'warning');
  const early = telTimer().cueTracker();
  early(t, 0); early(t, 40000);
  assert.equal(early({ ...t, finished: true }, 40000), 'end', '提前按完成（完成卡）也播結束音效');
  assert.equal(early({ ...t, finished: true }, 40000), null, '只播一次');
  const prep = telTimer().cueTracker();
  const p = { ...t, mode: 'prep', duration: 90 };
  assert.deepEqual([0, 30000, 59900, 60100, 89900, 90000].map((ms) => prep(p, ms)).filter(Boolean), ['start', 'warning', 'end'], '調整準備：開始、剩 30 秒、時間到（沒有手動切換）');
  assert.equal(prep(t, 0), 'start', '準備結束接著開始比賽，再播一次開始');
  const repair = telTimer().cueTracker();
  assert.equal(repair({ ...t, mode: 'repair', duration: 300 }, 0), null, '維修計時不播');
});

test('開始準備或比賽時記下實際上場時間；指定上場不記', async () => {
  const api = setup();
  const timer = async (action, matchId) => (await worker.fetch(new Request(origin + '/api/timer', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action, matchId }) }), { DB: api.DB, viewer: { name: '主裁判', remote: true, role: 'referee' } })).json();
  await timer('field', 'R3');
  assert.equal(find((await api.get()).data, 'R3').actual ?? '', '', '指定上場不算開始比賽');
  await timer('prep', 'R3');
  const first = find((await api.get()).data, 'R3').actual;
  assert.match(first, /^\d{2}:\d{2}$/);
  await timer('match', 'R3');
  assert.equal(find((await api.get()).data, 'R3').actual, first, '只記第一次，之後不覆蓋');
});

test('指定上場：主審指定在場上的場次（排名賽順序不限）、淘汰賽手動選兩隊，計分員不能改', async () => {
  const api = setup();
  const as = (role) => ({ DB: api.DB, viewer: { name: role === 'referee' ? '主裁判' : '計分員', remote: true, role } });
  const timer = async (action, matchId = '', role = 'referee') => {
    const res = await worker.fetch(new Request(origin + '/api/timer', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action, matchId }) }), as(role));
    return { status: res.status, data: await res.json() };
  };
  const putAs = async (role, id, changes, base = {}) => {
    const res = await worker.fetch(new Request(origin + '/api/state', { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(edit(id, 'schedule', changes, base)) }), as(role));
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await timer('field', 'R3', 'edit')).status, 403, '計分員不能指定上場');
  // 排名賽順序不限：先上 R3（元智 A），再上 R1
  const r3 = await timer('field', 'R3');
  assert.equal(r3.status, 200);
  assert.deepEqual([r3.data.timer.mode, r3.data.timer.field], ['idle', 'R3'], '指定上場不會開始計時');
  assert.equal((await api.get()).data.timer.field, 'R3', '所有人輪詢都拿得到在場上的場次');
  const pub = JSON.parse(await (await api.raw('/api/public')).text());
  assert.equal(pub.timer.field, 'R3', '觀賽／字卡也拿得到');
  assert.equal((await timer('prep', 'R1')).data.timer.field, 'R1', '開始準備時自動把那一場設為在場上');
  assert.equal((await timer('reset')).data.timer.field, 'R1', '重設計時不清掉在場上的場次');
  // 淘汰賽：還沒有名次時不能指定上場；主審手動選兩隊後可以
  const noTeams = await timer('field', 'K2');
  assert.equal(noTeams.status, 400);
  assert.match(noTeams.data.error, /兩隊/);
  assert.equal((await putAs('edit', 'K2', { team: '中央 A', teamB: '元智 B' })).status, 403, '計分員不能改對戰隊伍');
  assert.equal((await putAs('referee', 'K2', { team: '中央 A', teamB: '中央 A' })).status, 400, '兩隊不能相同');
  assert.equal((await putAs('referee', 'K2', { team: '中央 A', teamB: '不存在的隊' })).status, 400, '只能選名單上的隊伍');
  const teams = await putAs('referee', 'K2', { team: '中央 A', teamB: '元智 B' });
  assert.equal(teams.status, 200, JSON.stringify(teams.data.error));
  const k2 = await timer('field', 'K2');
  assert.equal(k2.status, 200, JSON.stringify(k2.data.error));
  assert.deepEqual(k2.data.timer.field, 'K2');
  // 計分照常：兩隊就是主審指定的兩隊
  const scored = await putAs('referee', 'K2', { cardA: card({ 0: 2 }), cardB: card({ 0: 1 }), resultStatus: '已確認', signoff: '主裁' });
  assert.equal(scored.status, 200, JSON.stringify(scored.data.error));
  assert.deepEqual([find(scored.data, 'K2').scoredTeamA, find(scored.data, 'K2').scoredTeamB, find(scored.data, 'K2').winner], ['中央 A', '元智 B', '中央 A']);
  // 維修計時給上一場勝隊，不改變在場上的場次
  await timer('field', 'K3', 'referee').catch(() => {});
  await putAs('referee', 'K3', { team: '中央 B', teamB: '中原 A' });
  await timer('field', 'K3');
  assert.equal((await timer('repair', 'K2')).data.timer.field, 'K3');
  const history = await api.DB.prepare("SELECT after FROM history WHERE record_id = 'K2' AND field = 'timer'").all();
  assert.ok(history.results.some((h) => h.after === '指定上場：中央 A vs. 元智 B'), '指定上場記在修改歷史');
});

test('比賽計時：只有主裁判／總召能操作，所有人輪詢同步，觀賽也看得到', async () => {
  const api = setup();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const timer = async (action, matchId = '', role = 'referee', headers = {}) => {
    const res = await worker.fetch(new Request(origin + '/api/timer', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, matchId }),
    }), { DB: api.DB, viewer: { name: role === 'referee' ? '主裁判' : '計分員', remote: true, role } });
    return { status: res.status, data: await res.json() };
  };
  const first = await api.get();
  assert.deepEqual(first.data.timer, { version: 0, mode: 'idle', field: '' });

  assert.equal((await timer('match', 'R1', 'edit')).status, 403, '計分員不能操作計時');
  assert.equal((await timer('match', 'R1', 'view')).status, 403, '檢視不能操作計時');
  assert.equal((await timer('match', 'R1', 'referee', { origin: 'https://evil.example' })).status, 403, '跨站請求擋下');
  assert.equal((await timer('match', '')).status, 400, '要先選場次');
  assert.equal((await timer('repair', 'R1')).status, 400, '5 分鐘維修只用於下半場');
  assert.equal((await timer('pause')).status, 400, '沒有計時時不能暫停');

  const started = await timer('match', 'R1');
  assert.equal(started.status, 200);
  assert.deepEqual([started.data.timer.mode, started.data.timer.duration, started.data.timer.running, started.data.timer.title, started.data.timer.teams], ['match', 180, true, '中央 A 單隊計分', ['中央 A']]);
  const afterStart = (await api.get()).data;
  assert.equal(find(afterStart, 'R1').status, '進行中', '開始比賽時場次自動設為進行中');
  assert.equal(find(afterStart, 'R1').editedBy, '主裁判');

  // 賽務資料沒變，但計時變了：帶舊的計時版本不能回 204
  const poll = (t) => worker.fetch(new Request(origin + `/api/state?since=${afterStart.revision}&t=${t}`), { DB: api.DB, viewer: { name: 'x', remote: true, role: 'edit' } });
  assert.equal((await poll(0)).status, 200);
  assert.equal((await poll(started.data.timer.version)).status, 204);

  await sleep(40);
  const paused = await timer('pause');
  assert.equal(paused.data.timer.running, false);
  assert.ok(paused.data.timer.elapsedMs >= 30, '暫停時保留已經過的時間');
  await sleep(40);
  const still = (await api.get()).data.timer;
  assert.equal(still.elapsedMs, paused.data.timer.elapsedMs, '暫停中時間不走');
  assert.equal((await timer('resume')).data.timer.running, true);
  assert.equal((await timer('stall')).data.timer.stallRunning, true, '靜止倒數 30 秒');
  const done = await timer('finish');
  assert.deepEqual([done.data.timer.finished, done.data.timer.running, done.data.timer.stallMs], [true, false, null]);
  assert.equal((await timer('resume')).status, 400, '完成後不能再繼續');

  // 觀賽資料也有計時，但不含操作人
  const pub = await (await worker.fetch(new Request(origin + '/api/public'), { DB: api.DB, viewer: { name: '觀摩', remote: true, role: 'view' } })).json();
  assert.equal(pub.timer.mode, 'match');
  assert.equal(pub.timer.by, undefined);
  assert.equal((await worker.fetch(new Request(origin + `/api/public?since=${pub.revision}&t=${pub.timer.version}`), { DB: api.DB })).status, 204);

  // 每次操作記在場次的修改歷史
  const history = await (await api.raw('/api/history?id=R1')).json();
  assert.deepEqual(history.history.map((h) => h.field).filter((f) => f !== 'actual'), ['timer', 'timer', 'timer', 'timer', 'status', 'timer']);
  assert.equal(history.history.filter((h) => h.field === 'actual').length, 1, '實際上場時間只記一次');
  assert.match(history.history[0].after, /^完成（記錄用時）（正式比賽 3 分鐘 已過 \d+ 秒）$/);
  assert.equal(history.history.at(-1).by, '主裁判');

  assert.equal((await timer('repair', 'K1')).data.timer.duration, 300, '下半場晉級隊維修 5 分鐘');
  assert.deepEqual((await timer('reset')).data.timer.mode, 'idle');

  // 只有一個場地：開始下一場時，上一場從「進行中」改成「已完成」；觀賽「現在」不會卡在上一場。
  await timer('prep', 'R2');
  const next = (await api.get()).data;
  assert.deepEqual([find(next, 'R1').status, find(next, 'R2').status], ['已完成', '進行中']);
  // 主裁確認成績＝這場比完：進行中 → 已完成。
  const confirmed = await api.put('主裁判', edit('R2', 'schedule', { cardA: card({ 4: 2 }), rank: '1', resultStatus: '已確認', signoff: '主裁' }));
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data.error));
  assert.equal(find(confirmed.data, 'R2').status, '已完成');
});

test('計時顯示規則：前 60 秒亮燈、時間到、暫停、完成用時', async () => {
  const { telTimer } = await import('../worker/timer.js');
  const t = telTimer();
  const match = { mode: 'match', duration: 180, running: true, finished: false, title: '附加賽', teams: ['元智 B', '中原 A'] };
  const early = t.describe(match, 1000);
  assert.deepEqual([early.clock, early.tone, early.match], ['2:59', 'auto', '附加賽 · 元智 B vs. 中原 A']);
  assert.match(early.sub, /小洞亮燈中（0:59 後熄燈）/);
  assert.match(t.describe(match, 60000).sub, /第 61 秒起.*小洞已熄燈/);
  assert.deepEqual([t.describe(match, 180000).tone, t.describe(match, 180000).clock], ['over', '0:00']);
  assert.match(t.describe({ ...match, running: false }, 5000).sub, /^⏸ 暫停中/);
  assert.match(t.describe({ ...match, running: false, finished: true }, 95300).sub, /用時 1:36（96 秒）/, '未滿 1 秒以 1 秒計');
  assert.match(t.describe(match, 70000, 4200).stall, /倒數 5 秒/);
  assert.match(t.describe(match, 70000, 0).stall, /救援卡/);
  assert.match(t.describe({ mode: 'prep', duration: 90, running: true }, 90000).sub, /準備時間到/);
  assert.equal(t.describe({ mode: 'idle' }, 0), null);
});
