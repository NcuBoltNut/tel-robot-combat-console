// 啟動真正的 server.mjs：本機埠、Tailscale 專用埠、個人通行碼登入、權限、人員名單、自動備份。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { call, startServer } from './helpers/server.mjs';

const funnelHost = 'tel-test.example.ts.net:10000';
const funnelOrigin = 'https://' + funnelHost;
let server;
let port;
let publicPort;
let dataDir;
let scorerA; // 計分
let chief; // 主裁判／總召

// 模擬 Tailscale Funnel 轉進來的請求。
const viaFunnel = (options = {}) => call(publicPort, {
  ...options, headers: { host: funnelHost, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', ...options.headers },
});
const login = (code, ip = '203.0.113.7', name = '') => viaFunnel({
  method: 'POST', path: '/login', body: new URLSearchParams({ code, name }).toString(),
  headers: { origin: funnelOrigin, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
});
const sessionFor = async (code, ip, name) => (await login(code, ip, name)).headers['set-cookie'][0].split(';')[0];
const stateFor = async (cookie) => JSON.parse((await viaFunnel({ path: '/api/state', headers: { cookie } })).text);
const manage = (cookie, path, body, origin = funnelOrigin) => viaFunnel({ method: 'POST', path, body: JSON.stringify(body),
  headers: { cookie, origin, 'content-type': 'application/json' } });

test.before(async () => {
  server = await startServer();
  ({ port, publicPort, dataDir } = server);
  scorerA = await server.addPerson('王小明（計分 A）', 'edit');
  chief = await server.addPerson('林總召', 'referee');
});
test.after(async () => { await server?.stop(); });

test('OBS 免登入連結：/obs/<攝影通行碼> 直接開啟直播字卡；其他權限的通行碼無效', async () => {
  const camera = await server.addPerson('攝影', 'camera');
  const ip = '203.0.113.71';
  const link = await viaFunnel({ path: '/obs/' + camera.code + '?bg=none', headers: { 'x-forwarded-for': ip } });
  assert.equal(link.status, 303);
  assert.equal(link.headers.location, '/overlay?bg=none');
  const cookie = link.headers['set-cookie'][0].split(';')[0];
  const page = await viaFunnel({ path: '/overlay?bg=none', headers: { cookie, 'x-forwarded-for': ip } });
  assert.equal(page.status, 200);
  assert.match(page.text, /直播字卡/);
  assert.equal((await viaFunnel({ path: '/api/public', headers: { cookie, 'x-forwarded-for': ip } })).status, 200);
  assert.equal((await viaFunnel({ path: '/api/state', headers: { cookie, 'x-forwarded-for': ip } })).status, 403, '攝影身分不能讀控制台');
  assert.equal((await viaFunnel({ path: '/obs/' + chief.code, headers: { 'x-forwarded-for': ip } })).status, 404, '主裁判的通行碼不能當免登入連結');
  assert.equal((await viaFunnel({ path: '/obs/NOPE2345', headers: { 'x-forwarded-for': ip } })).status, 404);
  assert.equal((await viaFunnel({ method: 'POST', path: '/obs/' + camera.code, headers: { 'x-forwarded-for': ip } })).status, 405);
});

test('比賽音效檔：本機可取得；對外埠要登入，任何權限登入後都能取得', async () => {
  const local = await call(port, { path: '/sounds/start.mp3', headers: { host: `127.0.0.1:${port}` } });
  assert.equal(local.status, 200);
  assert.equal(local.headers['content-type'], 'audio/mpeg');
  assert.equal((await viaFunnel({ path: '/sounds/end.mp3' })).status, 303, '未登入會被導到登入頁');
  const cookie = await sessionFor(server.viewCode, '203.0.113.81', '觀眾');
  for (const name of ['start', 'resume', 'warning', 'end']) assert.equal((await viaFunnel({ path: '/sounds/' + name + '.mp3', headers: { cookie, 'x-forwarded-for': '203.0.113.81' } })).status, 200, name);
  assert.equal((await call(port, { path: '/sounds/other.mp3', headers: { host: `127.0.0.1:${port}` } })).status, 404);
});

test('本機埠：免登入，但只接受本機 Host 且拒絕代理轉入', async () => {
  assert.equal((await call(port, { headers: { host: `127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call(port, { headers: { host: 'evil.example' } })).status, 400);
  const proxied = await call(port, { headers: { host: `127.0.0.1:${port}`, 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(proxied.status, 403);
  const state = JSON.parse((await call(port, { path: '/api/state', headers: { host: `localhost:${port}` } })).text);
  assert.deepEqual(state.viewer, { name: '本機', remote: false, role: 'referee', canManage: true, session: '' });
});

test('Tailscale 埠：未登入會被導到登入頁，API 回 401', async () => {
  const page = await viaFunnel();
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, '/login');
  assert.equal((await viaFunnel({ path: '/api/state' })).status, 401);
  assert.equal((await viaFunnel({ path: '/app.js' })).status, 303);
  assert.equal((await viaFunnel({ path: '/style.css' })).status, 200, '登入頁需要樣式');
  const form = await viaFunnel({ path: '/login' });
  assert.equal(form.status, 200);
  assert.match(form.text, /個人通行碼/);
  assert.match(form.headers['strict-transport-security'], /max-age/);
  // no-referrer 會讓 Chrome 把表單 POST 的 Origin 送成 null，導致無法登入。
  assert.equal(form.headers['referrer-policy'], 'same-origin');
});

test('Origin 為 null 時以 Sec-Fetch-Site 判斷同源', async () => {
  const post = (headers) => viaFunnel({
    method: 'POST', path: '/login', body: new URLSearchParams({ code: scorerA.code }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '192.0.2.50', ...headers },
  });
  assert.equal((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status, 303);
  assert.equal((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ origin: 'null' })).status, 403);
});

test('個人通行碼：姓名與權限由名單帶入，填了別的姓名也沒用', async () => {
  assert.equal((await login('WRONG123')).status, 401);
  const ok = await login(scorerA.code.toLowerCase(), '203.0.113.7', '冒名的人');
  assert.equal(ok.status, 303, '通行碼不分大小寫');
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  const session = cookie.split(';')[0];
  const { viewer } = await stateFor(session);
  assert.deepEqual([viewer.name, viewer.role, viewer.canManage], ['王小明（計分 A）', 'edit', false]);

  const body = JSON.stringify({ id: 'S01', type: 'schedule', changes: { actual: '10:02' }, base: {} });
  const put = (origin) => viaFunnel({ method: 'PUT', path: '/api/state', body, headers: { cookie: session, origin, 'content-type': 'application/json' } });
  assert.equal((await put('https://evil.example')).status, 403, '跨站寫入');
  const saved = await put(funnelOrigin);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(JSON.parse(saved.text).records.find((r) => r.id === 'S01').editedBy, '王小明（計分 A）');

  assert.equal((await viaFunnel({ path: '/api/state', headers: { cookie: session.slice(0, -2) + 'xx' } })).status, 401, '竄改的 cookie');
  const out = await viaFunnel({ method: 'POST', path: '/logout', headers: { cookie: session, origin: funnelOrigin } });
  assert.equal(out.status, 303);
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await viaFunnel({ path: '/api/state', headers: { cookie: session } })).status, 401, '登出後舊 cookie 立即失效');
});

test('共用檢視碼：直接進觀賽畫面，只拿得到公開資料', async () => {
  const viewer = await sessionFor(server.viewCode, '203.0.113.20', '觀摩新生 A');
  const home = await viaFunnel({ headers: { cookie: viewer } });
  assert.equal(home.status, 200);
  assert.match(home.text, /watch\.js/);
  assert.doesNotMatch(home.text, /app\.js/, '不載入後台程式');
  const pub = JSON.parse((await viaFunnel({ path: '/api/public', headers: { cookie: viewer } })).text);
  assert.deepEqual([pub.viewer.name, pub.viewer.role], ['觀摩新生 A', 'view']);
  assert.equal((await viaFunnel({ path: '/api/state', headers: { cookie: viewer } })).status, 403);
  assert.equal((await viaFunnel({ path: '/api/sessions', headers: { cookie: viewer } })).status, 403);
  const put = await viaFunnel({ method: 'PUT', path: '/api/state', body: JSON.stringify({ id: 'S02', type: 'schedule', changes: { actual: '10:31' }, base: {} }),
    headers: { cookie: viewer, origin: funnelOrigin, 'content-type': 'application/json' } });
  assert.equal(put.status, 403);
  const anonymous = await sessionFor(server.viewCode, '203.0.113.20');
  assert.equal(JSON.parse((await viaFunnel({ path: '/api/public', headers: { cookie: anonymous } })).text).viewer.name, '觀摩者', '沒填姓名時');
});

test('舊版共用的計分／主裁判通行碼不再有效', async () => {
  assert.equal((await login('TESTCODE9', '203.0.113.40')).status, 401);
  assert.equal((await login('JUDGECODE', '203.0.113.40')).status, 401);
});

test('登入失敗太多次只暫停該來源，不會鎖住全隊', async () => {
  const ip = '198.51.100.9';
  for (let i = 0; i < 30; i++) assert.equal((await login('NOPE1234', ip)).status, 401);
  assert.equal((await login(scorerA.code, ip)).status, 429, '暫停期間連正確通行碼也不接受');
  for (let i = 0; i < 60; i++) await login('NOPE1234', '192.0.2.' + (i % 30));
  assert.equal((await login(scorerA.code, '198.51.100.10')).status, 303, '大量來源亂猜之後，其他工作人員仍可登入');
});

test('權限：計分不能確認成績；主裁判／總召可以', async () => {
  const put = (cookie, change) => viaFunnel({ method: 'PUT', path: '/api/state', body: JSON.stringify(change),
    headers: { cookie, origin: funnelOrigin, 'content-type': 'application/json' } });
  const scorer = await sessionFor(scorerA.code, '203.0.113.22');
  const top = await sessionFor(chief.code, '203.0.113.23');
  const confirm = { id: 'R3', type: 'schedule', changes: { cardA: '{"grid":[2,0,0,0,0,0,0,0,0],"lit":0,"miss":0,"yellow":0,"rescue":3,"seconds":180,"outcome":"normal"}', resultStatus: '已確認', signoff: '主裁', rank: '3' }, base: {} };
  assert.equal((await put(scorer, confirm)).status, 403);
  assert.equal((await put(top, confirm)).status, 200);
});

test('人員名單：總召可新增、停用、重新產生；計分不能管理', async () => {
  const top = await sessionFor(chief.code, '203.0.113.32');
  const scorer = await sessionFor(scorerA.code, '203.0.113.31');
  assert.equal((await viaFunnel({ path: '/api/sessions', headers: { cookie: scorer } })).status, 403);
  assert.equal((await manage(scorer, '/api/people', { action: 'create', name: '偷加的人', role: 'referee' })).status, 403);
  assert.equal((await manage(top, '/api/people', { action: 'create', name: '陳攝影', role: 'edit' }, 'https://evil.example')).status, 403, '跨站新增');

  const created = await manage(top, '/api/people', { action: 'create', name: '陳攝影', role: 'edit' });
  assert.equal(created.status, 200, created.text);
  const { changed, people, viewCode } = JSON.parse(created.text);
  assert.match(changed.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(viewCode, server.viewCode);
  assert.ok(people.some((p) => p.name === '陳攝影' && p.active));
  assert.equal((await manage(top, '/api/people', { action: 'create', name: '陳攝影', role: 'edit' })).status, 400, '同名');
  assert.equal((await manage(top, '/api/people', { action: 'create', name: '某人', role: 'view' })).status, 400, '個人碼只能是計分或最高權限');

  const photographer = await sessionFor(changed.code, '203.0.113.33');
  assert.equal((await stateFor(photographer)).viewer.name, '陳攝影');
  // 重新產生：舊通行碼與舊登入都失效
  const regenerated = JSON.parse((await manage(top, '/api/people', { action: 'regenerate', id: changed.id })).text).changed.code;
  assert.notEqual(regenerated, changed.code);
  assert.equal((await viaFunnel({ path: '/api/state', headers: { cookie: photographer } })).status, 401);
  assert.equal((await login(changed.code, '203.0.113.34')).status, 401);
  const again = await sessionFor(regenerated, '203.0.113.34');
  // 停用：登入立即失效，也無法再登入；重新啟用後可再用
  assert.equal((await manage(top, '/api/people', { action: 'disable', id: changed.id })).status, 200);
  assert.equal((await viaFunnel({ path: '/api/state', headers: { cookie: again } })).status, 401);
  assert.equal((await login(regenerated, '203.0.113.35')).status, 401);
  assert.equal((await manage(top, '/api/people', { action: 'enable', id: changed.id })).status, 200);
  assert.equal((await login(regenerated, '203.0.113.35')).status, 303);
});

test('登入裝置：可撤銷單一裝置，對方可用通行碼重新登入', async () => {
  const top = await sessionFor(chief.code, '203.0.113.41');
  const scorer = await sessionFor(scorerA.code, '203.0.113.42');
  const listing = JSON.parse((await call(port, { path: '/api/sessions', headers: { host: `127.0.0.1:${port}` } })).text);
  const target = listing.sessions.find((s) => s.ip === '203.0.113.42');
  assert.equal(target.name, '王小明（計分 A）');
  assert.equal((await manage(top, '/api/sessions/revoke', { id: target.id }, 'https://evil.example')).status, 403, '跨站撤銷');
  assert.equal((await manage(top, '/api/sessions/revoke', { id: target.id })).status, 200);
  assert.equal((await viaFunnel({ path: '/api/state', headers: { cookie: scorer } })).status, 401, '被撤銷的手機立即失效');
  assert.equal((await viaFunnel({ path: '/api/state', headers: { cookie: top } })).status, 200);
  assert.equal((await login(scorerA.code, '203.0.113.42')).status, 303);
});

test('寫入後自動備份到 DATA_DIR/backups', async () => {
  await new Promise((resolve) => setTimeout(resolve, 6500));
  const files = readdirSync(join(dataDir, 'backups'));
  assert.ok(files.some((name) => /^tel-console-\d{8}-\d{6}\.sqlite$/.test(name)), files.join(','));
});
