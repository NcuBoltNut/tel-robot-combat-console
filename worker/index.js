import { teams, periods, kinds, statuses, pending, seed } from './seed.js';
import { telScoring } from './scoring.js';
import { telRules } from './rules.js';
import { client } from './client.js';
import { spectator } from './spectator.js';
import { telTimer } from './timer.js';
import { overlay, overlayHtml, overlayCss } from './overlay.js';
import { event } from './event.js';
import { html, css, watchHtml } from './ui.js';

const scoring = telScoring();
const rules = telRules({ teams, pending }, scoring);
const timing = telTimer();
const types = ['schedule','team','staff','task','incident','media'];
// 只由種子資料或伺服器決定的欄位，不接受前端修改。
const protectedKeys = ['id','type','match','sideA','sideB','editedBy','editedAt'];
const keyPattern = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const watchScript = `(${spectator.toString()})((${telTimer.toString()})(),${JSON.stringify(event)});`;
const overlayScript = `(${overlay.toString()})((${telTimer.toString()})(),${JSON.stringify(event)});`;
const appScript = `(${client.toString()})(${JSON.stringify({ teams, periods, kinds, statuses, pending, event })},(${telScoring.toString()})(),(${telRules.toString()})(${JSON.stringify({ teams, pending })},(${telScoring.toString()})()),(${telTimer.toString()})());`;

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function state(db) {
  const row = await db.prepare('SELECT revision, records, updated_at FROM tel_console WHERE id = 1').first();
  return row ? { revision: row.revision, records: JSON.parse(row.records), updatedAt: row.updated_at } : { revision: 0, records: seed, updatedAt: null };
}
const isStringMap = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.entries(value).every(([key, v]) => keyPattern.test(key) && typeof v === 'string' && v.length <= 3000);

function shapeError(record) {
  if (typeof record.title !== 'string' || !record.title.trim()) return '請填寫名稱。';
  if (!statuses.includes(record.status)) return '狀態不在清單內。';
  if (Object.keys(record).length > 60) return '欄位數量過多。';
  if (Object.values(record).some((v) => typeof v !== 'string' || v.length > 3000)) return '請檢查欄位內容。';
  return '';
}

// 欄位層級的合併：只有這次改動的欄位被別人先改成不同的值，才算衝突。
async function save(db, body, viewer) {
  if (viewer.role === 'view') return json({ error: '檢視通行碼只能查看，不能修改。' }, 403);
  const { id, type, isNew, changes, base = {} } = body ?? {};
  if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || !types.includes(type) || !isStringMap(changes) || !isStringMap(base) ||
    Object.keys(changes).length > 60 || Object.keys(changes).some((key) => protectedKeys.includes(key)))
    return json({ error: '請檢查欄位內容。' }, 400);
  const touched = Object.keys(changes);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await state(db);
    const index = current.records.findIndex((item) => item.id === id);
    const existing = index >= 0 ? current.records[index] : null;
    // 手機沒收到回應而重送同一筆新增：內容相同就當作成功，避免使用者再新增一筆重複的。
    if (isNew && existing) {
      if (existing.type === type && touched.every((key) => (existing[key] ?? '') === changes[key])) return json({ ...current, viewer });
      return json({ error: '紀錄編號重複，請重新新增。', state: current }, 409);
    }
    if (!isNew && !existing) return json({ error: '找不到這筆紀錄，請重新整理。', state: current }, 409);
    if (existing && existing.type !== type) return json({ error: '紀錄類型不符。' }, 400);
    const conflicts = existing ? touched.filter((key) => (existing[key] ?? '') !== (base[key] ?? '') && (existing[key] ?? '') !== changes[key]) : [];
    if (conflicts.length) return json({ error: '這些欄位剛被其他人修改。', conflicts, current: existing, state: current }, 409);
    if (!touched.length) return json({ ...current, viewer });

    const record = { ...(existing ?? {}), ...changes, id, type, ...(existing?.match ? { match: existing.match, sideA: existing.sideA, sideB: existing.sideB } : {}) };
    for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
    // 移除／復原場次只有主審或總召可以。
    if (viewer.role !== 'referee' && touched.includes('removed')) return json({ error: '移除或復原場次需要主裁判或總召的通行碼。' }, 403);
    // 淘汰賽的兩隊由主審手動指定（team／teamB），計分員不能改。
    if (viewer.role !== 'referee' && existing?.match === 'knockout' && touched.some((key) => key === 'team' || key === 'teamB'))
      return json({ error: '淘汰賽的對戰隊伍只有主裁判或總召可以指定。' }, 403);
    // 確認成績、修改或撤回已確認的成績，只有主裁判可以。
    if (viewer.role !== 'referee' && touched.some((key) => rules.scoreFields.includes(key)) &&
      (existing?.resultStatus === '已確認' || record.resultStatus === '已確認'))
      return json({ error: '確認成績或修改已確認的成績，需要主裁判或總召的通行碼。' }, 403);
    rules.prepare(current.records, record, touched);
    const problem = shapeError(record) || rules.check(current.records, record, existing, touched);
    if (problem) return json({ error: problem }, 400);
    record.editedBy = viewer.name || '未具名';
    record.editedAt = new Date().toISOString();

    const records = current.records.slice();
    if (existing) records[index] = record;
    else records.push(record);
    // 五場排名賽都確認後自動帶入名次；別場被帶入的名次記成「自動排名」修改。
    const autoFilled = [];
    for (const [rid, rank] of Object.entries(rules.autoRanks(records))) {
      if (rid === id) { record.rank = rank; continue; }
      const i = records.findIndex((r) => r.id === rid);
      const after = { ...records[i], rank, editedBy: '自動排名（依計分）', editedAt: record.editedAt };
      autoFilled.push([records[i], after]);
      records[i] = after;
    }
    const next = { revision: current.revision + 1, records, updatedAt: record.editedAt };
    const result = await db.prepare('INSERT INTO tel_console (id,revision,records,updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, records=excluded.records, updated_at=excluded.updated_at WHERE tel_console.revision=?')
      .bind(next.revision, JSON.stringify(records), next.updatedAt, current.revision).run();
    if (result.meta.changes === 1) {
      await recordHistory(db, existing, record, viewer);
      for (const [before, after] of autoFilled) await recordHistory(db, before, after, { role: 'system' });
      return json({ ...next, viewer });
    }
    // 另一個 Worker 執行個體剛好同時寫入：重新讀取後再合併一次。
  }
  return json({ error: '目前寫入的人太多，請稍後再按一次儲存。' }, 503);
}

// 同一個伺服器行程內的寫入排隊依序處理，避免同時送出的請求互相搶 revision 而失敗。
let writeQueue = Promise.resolve();
function queuedSave(db, body, viewer) {
  const run = writeQueue.then(() => save(db, body, viewer));
  writeQueue = run.catch(() => {});
  return run;
}

// 比賽計時：狀態存在 timer 表（伺服器重啟也接得上）。時間以伺服器時鐘為準，
// 回應時換算成「目前已經過幾毫秒」，前端再用自己的單調時鐘往下數，不受手機時鐘誤差影響。
async function readTimer(db) {
  const row = await db.prepare('SELECT version, data FROM timer WHERE id = 1').first();
  return row ? { ...JSON.parse(row.data), version: row.version } : { version: 0, mode: 'idle' };
}
function timerView(t, records, now = Date.now(), full = true) {
  // field＝主審指定「現在在場上」的場次；計分員的計分視窗依此自動切換，字卡與觀賽畫面也以它為「現在」。
  if (!timing.modes[t.mode]) return { version: t.version, mode: 'idle', field: t.field ?? '' };
  const total = t.duration * 1000;
  const elapsedMs = Math.min(total, t.elapsed + (t.since ? now - t.since : 0));
  const record = records.find((r) => r.id === t.matchId);
  return {
    version: t.version, mode: t.mode, matchId: t.matchId, title: record?.title ?? '',
    teams: record ? rules.sides(records, record) : [], duration: t.duration, elapsedMs, field: t.field ?? '',
    running: Boolean(t.since) && elapsedMs < total, finished: Boolean(t.finished),
    stallMs: t.stallOn ? Math.min(timing.STALL, t.stallElapsed + (t.stallSince ? now - t.stallSince : 0)) : null,
    stallRunning: Boolean(t.stallOn && t.stallSince),
    ...(full ? { by: t.by ?? '', at: t.at ?? '' } : {}),
  };
}
const taipeiTime = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
async function timerAction(db, body, viewer) {
  if (viewer.role !== 'referee') return json({ error: '只有主裁判或總召可以操作計時。' }, 403);
  const { action, matchId = '' } = body ?? {};
  if (!timing.actions[action]) return json({ error: '不支援的計時操作。' }, 400);
  const current = await state(db);
  const t = await readTimer(db);
  const now = Date.now();
  const active = Boolean(timing.modes[t.mode]);
  const total = (t.duration ?? 0) * 1000;
  const elapsed = active ? Math.min(total, t.elapsed + (t.since ? now - t.since : 0)) : 0;
  const over = active && elapsed >= total;
  const stallElapsed = t.stallOn ? t.stallElapsed + (t.stallSince ? now - t.stallSince : 0) : 0;
  const fail = (message) => json({ error: message, timer: timerView(t, current.records, now) }, 400);
  let next;
  if (action === 'field') {
    // 指定上場：不動目前的計時（例如上一場勝隊的維修可以繼續跑），只換「在場上」的場次。
    const record = current.records.find((r) => r.id === matchId && r.match);
    if (!record) return fail('請先選擇場次。');
    if (rules.removed(record)) return fail('這場已被移除，請先復原。');
    if (record.match === 'knockout') {
      const names = rules.sides(current.records, record);
      if (!names[0] || !names[1] || names[0] === names[1]) return fail('請先選好這場的兩隊（不能是同一隊）。');
    }
    next = { ...(active ? t : { mode: 'idle' }), field: matchId };
  } else if (timing.modes[action]) {
    const record = current.records.find((r) => r.id === matchId && r.match);
    if (!record) return fail('請先選擇場次。');
    if (rules.removed(record)) return fail('這場已被移除，請先復原。');
    if (action === 'repair' && record.match !== 'knockout') return fail('5 分鐘維修只用於下半場晉級隊伍。');
    // 維修是給上一場勝隊的，不改變在場上的場次；準備與比賽則把這場設為在場上。
    next = { mode: action, matchId, duration: timing.modes[action][1], elapsed: 0, since: now, finished: false, stallOn: false, stallElapsed: 0, stallSince: null, field: action === 'repair' ? t.field ?? '' : matchId };
  } else if (action === 'reset') {
    next = { mode: 'idle', field: t.field ?? '' };
  } else if (!active) {
    return fail('目前沒有進行中的計時。');
  } else if (action === 'pause') {
    if (!t.since || over) return fail('計時沒有在跑。');
    next = { ...t, elapsed, since: null, stallElapsed, stallSince: null };
  } else if (action === 'resume') {
    if (t.since || over || t.finished) return fail('這段計時不能繼續。');
    next = { ...t, since: now, stallSince: t.stallOn ? now : null };
  } else if (action === 'finish') {
    if (t.mode !== 'match' || t.finished) return fail('只有正式比賽可以按完成。');
    next = { ...t, elapsed, since: null, finished: true, stallOn: false, stallElapsed: 0, stallSince: null };
  } else if (action === 'stall') {
    if (t.mode !== 'match' || !t.since || over) return fail('比賽進行中才能開始靜止倒數。');
    next = { ...t, stallOn: true, stallElapsed: 0, stallSince: now };
  } else {
    next = { ...t, stallOn: false, stallElapsed: 0, stallSince: null };
  }
  delete next.version;
  next.by = viewer.name || '本機';
  next.at = new Date(now).toISOString();
  await db.prepare('INSERT INTO timer (id, version, data) VALUES (1, 1, ?) ON CONFLICT(id) DO UPDATE SET version = timer.version + 1, data = excluded.data').bind(JSON.stringify(next)).run();
  // 記在該場次的修改歷史，事後有爭議時可以查計時是誰、何時按的。
  const recordId = timing.modes[action] || action === 'field' ? matchId : t.matchId;
  if (recordId) {
    const fieldRecord = action === 'field' ? current.records.find((r) => r.id === matchId) : null;
    const note = action === 'field' ? '指定上場：' + rules.sides(current.records, fieldRecord).filter(Boolean).join(' vs. ')
      : timing.actions[action] + (active && !timing.modes[action] ? '（' + timing.modes[t.mode][0] + ' 已過 ' + timing.usedSeconds(t, elapsed) + ' 秒）' : '');
    try {
      await db.prepare('INSERT INTO history (record_id, field, before, after, by, role, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(recordId, 'timer', '', note, next.by, viewer.role, next.at).run();
    } catch (err) { console.error('寫入計時紀錄失敗：', err); }
  }
  // 開始調整準備或比賽：場次狀態自動設為「進行中」，觀賽畫面的「現在」跟著切換。
  // 只有一個場地，同時只會有一場在比：其他還掛著「進行中」的場次改成「已完成」。
  if ((action === 'prep' || action === 'match') && recordId) {
    for (const other of current.records.filter((r) => r.match && r.id !== recordId && r.status === '進行中')) {
      const res = await save(db, { id: other.id, type: other.type, changes: { status: '已完成' }, base: { status: '進行中' } }, viewer);
      if (!res.ok) console.error('計時：上一場狀態沒有改成已完成', await res.text());
    }
    // 第一次開始準備／比賽時記下實際上場時間（排名賽順序不固定，成績頁依此排序）。
    const record = current.records.find((r) => r.id === recordId);
    const changes = {}, base = {};
    if (record && record.status !== '進行中') { changes.status = '進行中'; base.status = record.status ?? ''; }
    if (record && !record.actual) { changes.actual = taipeiTime.format(new Date(now)); base.actual = ''; }
    if (Object.keys(changes).length) {
      const res = await save(db, { id: record.id, type: record.type, changes, base }, viewer);
      if (!res.ok) console.error('計時：場次狀態或實際時間沒有寫入', await res.text());
    }
  }
  return json({ timer: timerView(await readTimer(db), current.records, now) });
}
// 讀取快取：同一個版本只解析一次、觀賽資料只算一次，幾百支手機同時輪詢時共用。
// 以資料庫的 revision 為準，多個執行個體或伺服器重啟都不會拿到舊資料。快取的內容不可修改。
let snapshot = null;
async function snapshotFor(db, revision) {
  if (snapshot && snapshot.revision === revision) return snapshot;
  const row = await db.prepare('SELECT revision, records, updated_at FROM tel_console WHERE id = 1').first();
  const raw = row ? row.records : JSON.stringify(seed);
  snapshot = { revision: row ? row.revision : 0, records: JSON.parse(raw), raw, updatedAt: row ? row.updated_at : null, publicJson: null };
  return snapshot;
}
const rawJson = (body) => new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
// 每 0.5 秒的輪詢先只讀版本號，沒變就不讀整份資料。
async function revisionOnly(db) {
  const row = await db.prepare('SELECT revision FROM tel_console WHERE id = 1').first();
  return { revision: row?.revision ?? 0 };
}
// 輪詢：賽務資料與計時都沒變才回 204（舊版前端沒帶 t 時只看 revision）。
const unchanged = (url, current, t) => url.searchParams.get('since') === String(current.revision) &&
  (!url.searchParams.has('t') || url.searchParams.get('t') === String(t.version));

// 修改歷史：每個變動的欄位一列，處理異議時可以查「原本是多少、誰改的」。
async function recordHistory(db, before, after, viewer) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].filter((key) => !['editedBy', 'editedAt'].includes(key));
  for (const key of keys) {
    const was = before?.[key] ?? '';
    const now = after[key] ?? '';
    if (was === now) continue;
    try {
      await db.prepare('INSERT INTO history (record_id, field, before, after, by, role, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(after.id, key, was, now, after.editedBy, viewer.role, after.editedAt).run();
    } catch (err) {
      console.error('寫入修改歷史失敗：', err);
      return;
    }
  }
}

const csvCell = (value) => {
  let text = String(value ?? '');
  // 避免 Excel 把 = + - @ 開頭的內容當成公式執行。
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
};
function resultsCsv(records) {
  const header = ['場次編號', '場次', '原訂時間', '實際時間', 'A 方／隊伍', 'B 方', 'A 方得分', 'B 方得分', '名次', '勝者', '成績狀態', '簽認', '計分備註', '最後修改', '修改時間'];
  const rows = records.filter((r) => r.match && !rules.removed(r)).map((r) => {
    const names = rules.sides(records, r);
    return [r.id, r.title, r.time, r.actual, names[0] || r.sideA || '', r.match === 'knockout' ? names[1] || r.sideB || '' : '',
      r.scoreA, r.match === 'knockout' ? r.scoreB : '', r.rank, r.winner, rules.scoreState(records, r), r.signoff, r.scoreNotes, r.editedBy, r.editedAt];
  });
  return '\ufeff' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// 觀賽畫面用的公開資料：只有賽程、隊伍名稱與「主裁判已確認」的成績。
// 不含聯絡方式、計分明細、備註、工作人員與任務，也不含尚未確認的暫定分數。
const doneStatuses = ['已完成', '已確認', '已結案'];
function publicEventStatus(r) {
  if (r.status === '進行中') return '進行中';
  if (doneStatuses.includes(r.status)) return '已完成';
  if (['延誤', '暫停', '取消'].includes(r.status)) return r.status;
  return '未開始';
}
// 觀賽畫面的計分明細：計分員點擊時即時同步，尚未確認的以「暫定」顯示。
// 淘汰賽若隊伍已異動（明細屬於舊對戰），不公開。
function publicCard(r, side, stale) {
  if (stale || !r['card' + side]) return null;
  const card = scoring.read(r['card' + side]);
  const result = scoring.scoreSide(r, side);
  if (!card || !result || result.error) return null;
  return {
    grid: card.grid, lit: card.lit, hole: card.hole ?? 0, miss: card.miss, yellow: card.yellow, rescue: card.rescue,
    outcome: card.outcome === 'normal' ? '' : scoring.outcomes[card.outcome], total: result.total, base: result.base, bonus: result.bonus,
    connectionPoints: result.connectionPoints, connectionCount: result.connectionCount, net: result.net, multiplier: result.multiplier,
  };
}
function publicMatch(records, r) {
  const names = rules.sides(records, r);
  const knockout = r.match === 'knockout';
  const confirmed = rules.scoreState(records, r) === '已確認';
  const stale = knockout && Boolean(r.cardA || r.cardB) && (r.scoredTeamA !== (names[0] || '') || r.scoredTeamB !== (names[1] || ''));
  const cardA = publicCard(r, 'A', stale);
  const cardB = knockout ? publicCard(r, 'B', stale) : null;
  const skipped = rules.skipped(records, r);
  const state = skipped ? '不舉行' : confirmed ? '已公布'
    : r.status === '進行中' ? '比賽中'
    : r.resultStatus === '進行中' || doneStatuses.includes(r.status) ? '計分中'
    : ['延誤', '暫停', '取消'].includes(r.status) ? r.status : '未開始';
  return {
    id: r.id, title: r.title, time: r.time ?? '', actual: r.actual ?? '', match: r.match, state,
    teamA: names[0] || '', teamB: knockout ? names[1] || '' : '',
    slotA: knockout ? rules.slotLabel(records, r, 'A') ?? '' : '', slotB: knockout ? rules.slotLabel(records, r, 'B') ?? '' : '', skipped,
    scoreA: confirmed ? r.scoreA ?? '' : cardA ? String(cardA.total) : '',
    scoreB: !knockout ? '' : confirmed ? r.scoreB ?? '' : cardB ? String(cardB.total) : '',
    provisional: !confirmed && Boolean(cardA || cardB), cardA, cardB, target: ['1', '2', '3'].includes(r.target) ? r.target : '',
    rank: confirmed && !knockout ? r.rank ?? '' : '', winner: confirmed && knockout ? r.winner ?? '' : '',
  };
}
function publicView(current) {
  const { records } = current;
  const order = (a, b) => periods.indexOf(a.period) - periods.indexOf(b.period) || String(a.time ?? '').localeCompare(String(b.time ?? ''));
  const schedule = records.filter((r) => r.type === 'schedule' && !rules.removed(r)).sort(order);
  const matches = schedule.filter((r) => r.match).map((r) => publicMatch(records, r));
  return {
    revision: current.revision, updatedAt: current.updatedAt,
    events: schedule.map((r) => ({ id: r.id, time: r.time ?? '', actual: r.actual ?? '', title: r.title, period: r.period,
      status: r.match ? matches.find((m) => m.id === r.id).state : publicEventStatus(r), match: Boolean(r.match) })),
    ranking: matches.filter((m) => m.match === 'ranking'),
    knockout: matches.filter((m) => m.match === 'knockout'),
    champion: matches.find((m) => m.id === 'K4')?.winner ?? '',
    teams: records.filter((r) => r.type === 'team').map((r) => ({ name: r.title, school: r.school ?? '' })),
  };
}
const pageHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" };
// 檢視通行碼只能使用觀賽畫面；其餘頁面與 API 一律拒絕，避免拿到聯絡方式等內部資料。
const spectatorPaths = ['/', '/watch', '/watch.js', '/style.css', '/api/public'];
// 攝影（直播字卡）通行碼：只能看字卡與觀賽畫面，登入後首頁就是滿版字卡。
const cameraPaths = [...spectatorPaths, '/overlay', '/overlay.js', '/overlay.css'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 本機與未經 server.mjs 的部署視為主裁判權限；server.mjs 會依登入的通行碼帶入 role。
    const viewer = {
      name: env.viewer?.name ?? '', remote: Boolean(env.viewer?.remote),
      role: ['view', 'camera', 'edit', 'referee'].includes(env.viewer?.role) ? env.viewer.role : 'referee',
      canManage: Boolean(env.viewer?.canManage), session: env.viewer?.session ?? '',
    };
    if (viewer.role === 'view' && !spectatorPaths.includes(url.pathname))
      return url.pathname.startsWith('/api/') ? json({ error: '檢視通行碼只能使用觀賽畫面。' }, 403) : new Response('檢視通行碼只能使用觀賽畫面。', { status: 403 });
    if (viewer.role === 'camera' && !cameraPaths.includes(url.pathname))
      return url.pathname.startsWith('/api/') ? json({ error: '攝影通行碼只能使用直播字卡與觀賽畫面。' }, 403) : new Response('攝影通行碼只能使用直播字卡與觀賽畫面。', { status: 403 });
    if (url.pathname === '/api/public' && request.method === 'GET') {
      try {
        const t = await readTimer(env.DB);
        const latest = await revisionOnly(env.DB);
        if (unchanged(url, latest, t)) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
        const snap = await snapshotFor(env.DB, latest.revision);
        snap.publicJson ??= JSON.stringify(publicView(snap)).slice(0, -1);
        return rawJson(snap.publicJson + ',"timer":' + JSON.stringify(timerView(t, snap.records, Date.now(), false)) +
          ',"viewer":' + JSON.stringify({ name: viewer.name, remote: viewer.remote, role: viewer.role }) + '}');
      } catch (err) {
        console.error(err);
        return json({ error: '目前無法讀取賽程，請稍後重試。' }, 503);
      }
    }
    if (url.pathname === '/overlay.js') return new Response(overlayScript, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    if (url.pathname === '/overlay.css') return new Response(overlayCss, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' } });
    if (url.pathname === '/overlay' || (url.pathname === '/' && viewer.role === 'camera')) return new Response(overlayHtml, { headers: pageHeaders });
    if (url.pathname === '/watch.js') return new Response(watchScript, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    if (url.pathname === '/watch' || (url.pathname === '/' && viewer.role === 'view')) return new Response(watchHtml, { headers: pageHeaders });
    if (url.pathname === '/api/state') {
      try {
        if (request.method === 'GET') {
          const t = await readTimer(env.DB);
          const latest = await revisionOnly(env.DB);
          if (unchanged(url, latest, t)) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
          const snap = await snapshotFor(env.DB, latest.revision);
          return rawJson('{"revision":' + snap.revision + ',"records":' + snap.raw + ',"updatedAt":' + JSON.stringify(snap.updatedAt) +
            ',"timer":' + JSON.stringify(timerView(t, snap.records)) + ',"viewer":' + JSON.stringify(viewer) + '}');
        }
        if (request.method !== 'PUT') return json({ error: '不支援的操作。' }, 405);
        if (request.headers.get('origin') !== url.origin || !request.headers.get('content-type')?.startsWith('application/json')) return json({ error: '請從本站儲存。' }, 403);
        let body;
        try { body = await request.json(); } catch { return json({ error: '資料格式有誤。' }, 400); }
        return await queuedSave(env.DB, body, viewer);
      } catch (err) {
        console.error(err);
        return json({ error: '目前無法讀寫賽務資料，請稍後重試。' }, 503);
      }
    }
    if (url.pathname === '/api/timer') {
      if (request.method !== 'POST') return json({ error: '不支援的操作。' }, 405);
      if (request.headers.get('origin') !== url.origin || !request.headers.get('content-type')?.startsWith('application/json')) return json({ error: '請從本站操作。' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ error: '資料格式有誤。' }, 400); }
      try {
        const run = writeQueue.then(() => timerAction(env.DB, body, viewer));
        writeQueue = run.catch(() => {});
        return await run;
      } catch (err) {
        console.error(err);
        return json({ error: '目前無法操作計時，請再按一次。' }, 503);
      }
    }
    if (url.pathname === '/api/history' && request.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!/^[\w-]{1,80}$/.test(id)) return json({ error: '紀錄編號有誤。' }, 400);
      try {
        const { results } = await env.DB.prepare('SELECT field, before, after, by, role, at FROM history WHERE record_id = ? ORDER BY seq DESC LIMIT 300').bind(id).all();
        return json({ history: results });
      } catch (err) {
        console.error(err);
        return json({ error: '目前無法讀取修改歷史。' }, 503);
      }
    }
    if (url.pathname === '/api/export.csv' && request.method === 'GET') {
      const { records } = await state(env.DB);
      const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      return new Response(resultsCsv(records), { headers: {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="tel-results-${day}.csv"; filename*=UTF-8''${encodeURIComponent('TEL賽務成績-' + day + '.csv')}`,
      } });
    }
    if (url.pathname === '/app.js') return new Response(appScript, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    if (url.pathname === '/style.css') return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' } });
    if (url.pathname !== '/') return new Response('找不到頁面', { status: 404 });
    return new Response(html, { headers: pageHeaders });
  },
};
