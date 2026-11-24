// 正式預設的四隊賽制：中央 A、中央 B、元智、中原。
// 以全新資料啟動真正的 server.mjs（不帶 TEL_TEAMS），走完排名賽 → 準決賽 → 冠軍賽。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, call } from './helpers/server.mjs';

const card = (cells, extra = {}) => JSON.stringify({ grid: Object.assign([0, 0, 0, 0, 0, 0, 0, 0, 0], cells), lit: 0, miss: 0, yellow: 0, rescue: 3, seconds: 180, outcome: 'normal', ...extra });

test('四隊賽制：預設賽程、名次自動帶入、第 1 vs 第 4、第 2 vs 第 3、冠軍賽', async () => {
  const server = await startServer({ env: { TEL_TEAMS: '' } });
  try {
    const headers = { host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json' };
    const get = async (path = '/api/state') => JSON.parse((await call(server.port, { path, headers })).text);
    const put = async (id, changes) => {
      const record = (await get()).records.find((r) => r.id === id);
      const base = Object.fromEntries(Object.keys(changes).map((k) => [k, String(record[k] ?? '')]));
      const res = await call(server.port, { method: 'PUT', path: '/api/state', headers, body: JSON.stringify({ id, type: 'schedule', changes, base }) });
      return { status: res.status, data: JSON.parse(res.text) };
    };

    const state = await get();
    const teams = state.records.filter((r) => r.type === 'team').map((r) => [r.title, r.school]);
    assert.deepEqual(teams, [['中央 A', '中央大學'], ['中央 B', '中央大學'], ['元智', '元智大學'], ['中原', '中原大學']]);
    const ranking = state.records.filter((r) => r.match === 'ranking').map((r) => [r.id, r.team, r.time]);
    assert.deepEqual(ranking, [['R1', '中央 A', '13:00–13:10'], ['R2', '中央 B', '13:10–13:20'], ['R3', '元智', '13:20–13:30'], ['R4', '中原', '13:30–13:40']]);
    const knockout = state.records.filter((r) => r.match === 'knockout').map((r) => [r.id, r.title, r.sideA, r.sideB]);
    assert.deepEqual(knockout, [['K2', '準決賽 A', '第 1 名', '第 4 名'], ['K3', '準決賽 B', '第 2 名', '第 3 名'], ['K4', '冠軍賽', '準決賽 A 勝者', '準決賽 B 勝者']]);

    // 排名賽：名次全部留白，第四場確認後自動帶入。元智 > 中央 B > 中原 > 中央 A
    const cells = { R1: { 0: 1 }, R2: { 0: 3, 1: 3 }, R3: { 0: 3, 1: 3, 2: 3 }, R4: { 0: 3 } };
    let res;
    for (const [id, g] of Object.entries(cells)) {
      res = await put(id, { cardA: card(g), resultStatus: '已確認', signoff: '主裁' });
      assert.equal(res.status, 200, id + '：' + JSON.stringify(res.data.error));
    }
    const rank = (id) => res.data.records.find((r) => r.id === id).rank;
    assert.deepEqual(['R1', 'R2', 'R3', 'R4'].map(rank), ['4', '2', '1', '3']);

    const play = async (id, a, b) => {
      const r = await put(id, { cardA: card(a), cardB: card(b), resultStatus: '已確認', signoff: '主裁' });
      assert.equal(r.status, 200, id + '：' + JSON.stringify(r.data.error));
      return r.data.records.find((x) => x.id === id);
    };
    const k2 = await play('K2', { 0: 1 }, { 0: 2 });
    assert.deepEqual([k2.scoredTeamA, k2.scoredTeamB, k2.winner], ['元智', '中央 A', '中央 A'], '第 1 名 vs. 第 4 名');
    const k3 = await play('K3', { 0: 2 }, { 0: 1 });
    assert.deepEqual([k3.scoredTeamA, k3.scoredTeamB, k3.winner], ['中央 B', '中原', '中央 B'], '第 2 名 vs. 第 3 名');
    const k4 = await play('K4', { 0: 2, 4: 2, 8: 2 }, { 0: 1 });
    assert.deepEqual([k4.scoredTeamA, k4.scoredTeamB, k4.winner], ['中央 A', '中央 B', '中央 A']);

    const pub = await get('/api/public');
    assert.equal(pub.champion, '中央 A');
    assert.deepEqual(pub.ranking.map((m) => [m.rank, m.teamA]).sort(), [['1', '元智'], ['2', '中央 B'], ['3', '中原'], ['4', '中央 A']]);
    assert.equal(pub.knockout.length, 3);
    assert.equal(pub.knockout.some((m) => m.skipped), false);
  } finally {
    await server.stop();
  }
});
