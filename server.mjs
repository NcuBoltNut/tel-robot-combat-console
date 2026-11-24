import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker/index.js';
import { createAuth, loadAccess, ROLE_LABELS } from './auth.mjs';
import { d1 } from './d1.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`請使用 Node.js 24 或更新版（目前是 ${process.version}）。用 nvm 的話可先執行 nvm use 25.4.0。`);
  process.exit(1);
}

function portFrom(name, fallback) {
  const raw = process.env[name] ?? fallback;
  if (raw === undefined || raw === '') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`${name} 請設定為 1 到 65535 的整數。`);
    process.exit(1);
  }
  return port;
}
const port = portFrom('PORT', '3000');
// 給 Tailscale Funnel／Serve 轉進來的專用埠；這個埠的每個請求都要登入。沒設定就不開。
const publicPort = portFrom('PUBLIC_PORT');
if (publicPort === port) {
  console.error('PUBLIC_PORT 不能和 PORT 相同。');
  process.exit(1);
}
const publicHost = (process.env.PUBLIC_HOST ?? '').trim().toLowerCase();

// 資料預設放在 %LOCALAPPDATA%\tel-robot-combat，避開 OneDrive 同步時鎖定或損毀 SQLite 檔。
const here = fileURLToPath(new URL('.', import.meta.url));
// 比賽音效（觀賽畫面與直播字卡用）：開始、第 60 秒手動開始、剩 30 秒、結束。啟動時讀進記憶體。
const sounds = new Map(['start', 'resume', 'warning', 'end'].map((name) => {
  const file = join(here, 'sounds', name + '.mp3');
  return [name, existsSync(file) ? readFileSync(file) : null];
}));
const legacyDir = join(here, 'data');
const dataDir = resolve(process.env.DATA_DIR || (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'tel-robot-combat') : legacyDir));
const backupDir = join(dataDir, 'backups');
mkdirSync(backupDir, { recursive: true });
const dbFile = join(dataDir, 'tel-console.sqlite');
const legacyDb = join(legacyDir, 'tel-console.sqlite');
if (resolve(legacyDir) !== dataDir && !existsSync(dbFile) && existsSync(legacyDb)) {
  copyFileSync(legacyDb, dbFile);
  console.log(`已把舊資料複製到 ${dbFile}（原檔保留在 ${legacyDb}）。`);
}
if (/onedrive|dropbox|google drive/i.test(dataDir)) console.warn(`警告：資料夾 ${dataDir} 位於雲端同步資料夾，同步時可能鎖住資料庫。建議改設 DATA_DIR。`);

const { DatabaseSync } = await import('node:sqlite');
const database = new DatabaseSync(dbFile);
database.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

// 自動備份：每次寫入後最多每分鐘備份一次，保留最近 200 份；啟動及關閉時各備份一次。
const KEEP_BACKUPS = 200;
let lastBackup = 0;
let dirty = false;
let backupTimer = null;
const stamp = () => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};
function backup() {
  if (!database.prepare('SELECT 1 FROM tel_console WHERE id = 1').get()) return;
  const file = join(backupDir, `tel-console-${stamp()}.sqlite`);
  if (!existsSync(file)) database.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  lastBackup = Date.now();
  dirty = false;
  const files = readdirSync(backupDir).filter((name) => /^tel-console-\d{8}-\d{6}\.sqlite$/.test(name)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) rmSync(join(backupDir, old), { force: true });
}
function safeBackup() {
  try { backup(); } catch (err) { console.error('自動備份失敗：', err); }
}
function scheduleBackup() {
  dirty = true;
  if (backupTimer) return;
  backupTimer = setTimeout(() => { backupTimer = null; safeBackup(); }, Math.max(5000, lastBackup + 60000 - Date.now()));
}
safeBackup();

const DB = d1(database, scheduleBackup);

const access = publicPort ? loadAccess(dataDir) : null;
const auth = access ? createAuth(access, database) : null;
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const proxyHeaders = ['x-forwarded-for', 'x-forwarded-host', 'tailscale-user-login', 'tailscale-funnel-request'];
const textHeaders = { 'Content-Type': 'text/plain; charset=utf-8' };
const loginCsp = "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const firstValue = (value) => String(value ?? '').split(',')[0].trim();

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 1024 * 1024) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 對外埠的網址：Tailscale 會帶 Host 或 X-Forwarded-Host；以瀏覽器 Origin 吻合的那一個為準。
function publicOrigin(req) {
  const candidates = [firstValue(req.headers['x-forwarded-host']), firstValue(req.headers.host)]
    .filter((host) => /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) && !localHosts.has(host));
  if (!candidates.length) return null;
  const proto = firstValue(req.headers['x-forwarded-proto']) === 'http' ? 'http' : 'https';
  const fromOrigin = (() => { try { return new URL(req.headers.origin).host; } catch { return ''; } })();
  const host = candidates.find((h) => h === fromOrigin) ?? candidates[0];
  if (publicHost && host.toLowerCase().split(':')[0] !== publicHost.split(':')[0]) return null;
  return `${proto}://${host}`;
}

function handler(isPublic) {
  const security = isPublic
    // 不能用 no-referrer：Chrome 會因此把表單 POST 的 Origin 送成 null，登入會被同源檢查擋下。
    ? { 'Strict-Transport-Security': 'max-age=31536000', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' }
    : { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' };
  return async (req, res) => {
    const send = (status, headers = {}, body = '') => { res.writeHead(status, { ...security, ...headers }); res.end(body); };
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return send(400);
    let origin;
    if (isPublic) {
      origin = publicOrigin(req);
      if (!origin) return send(400, textHeaders, '網址不正確。');
    } else {
      if (!localHosts.has(req.headers.host)) return send(400);
      // Tailscale 若誤轉到本機埠會帶代理標頭；本機埠免登入，因此直接拒絕。
      if (proxyHeaders.some((name) => req.headers[name])) return send(403, textHeaders, '這個連接埠只給本機使用。Tailscale 請轉到 PUBLIC_PORT。');
      origin = `http://${req.headers.host}`;
    }

    try {
      const body = await readBody(req);
      if (!body) return send(413, { Connection: 'close' });
      const path = new URL(req.url, origin).pathname;
      // 主控電腦：最高權限，可管理登入裝置。
      let viewer = { name: '本機', remote: false, role: 'referee', canManage: Boolean(auth) };
      // Origin 為 null 時改看瀏覽器自動加的 Sec-Fetch-Site（網頁無法偽造）。
      const sameOrigin = req.headers.origin === origin ||
        ((!req.headers.origin || req.headers.origin === 'null') && req.headers['sec-fetch-site'] === 'same-origin');

      if (isPublic) {
        const client = firstValue(req.headers['x-forwarded-for']) || 'unknown';
        const html = (status, page, extra = {}) => send(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': loginCsp, ...extra }, page);
        const current = auth.session(req.headers.cookie);
        // OBS 等無法操作畫面的瀏覽器：/obs/<攝影通行碼> 直接以攝影身分登入並開啟直播字卡（保留 ?bg= 等參數）。
        // 只接受「攝影」權限的通行碼；其他人的通行碼一律當作無效，避免變成免登入進後台的捷徑。
        const obs = /^\/obs\/([A-Za-z0-9]{4,32})$/.exec(path);
        if (obs) {
          if (req.method !== 'GET') return send(405);
          if (!auth.allowed(client)) return send(429, textHeaders, '嘗試次數過多，請 10 分鐘後再試。');
          const identity = auth.identify(obs[1]);
          if (!identity || identity.role !== 'camera') {
            auth.fail(client);
            return send(404, textHeaders, '直播字卡連結無效或已停用。');
          }
          auth.clear(client);
          const { name, cookie } = auth.login(identity, '', client, req.headers['user-agent']);
          console.log(`直播字卡連結登入：${name}（${client}）`);
          return send(303, { Location: '/overlay' + new URL(req.url, origin).search, 'Set-Cookie': cookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        }
        if (path === '/login') {
          if (req.method === 'GET') return current ? send(303, { Location: '/' }) : html(200, auth.loginPage());
          if (req.method !== 'POST') return send(405);
          if (!sameOrigin) return send(403, textHeaders, '請從登入頁送出。');
          const form = new URLSearchParams(body.toString('utf8'));
          if (!auth.allowed(client)) return html(429, auth.loginPage('嘗試次數過多，請 10 分鐘後再試。'));
          const identity = auth.identify(form.get('code'));
          if (!identity) {
            auth.fail(client);
            return html(401, auth.loginPage('通行碼不正確，或已被停用。'));
          }
          auth.clear(client);
          const { name, cookie } = auth.login(identity, form.get('name'), client, req.headers['user-agent']);
          console.log(`登入：${name}｜${ROLE_LABELS[identity.role]}（${client}）`);
          return send(303, { Location: '/', 'Set-Cookie': cookie });
        }
        if (path === '/logout') {
          if (req.method !== 'POST' || !sameOrigin) return send(403);
          auth.logout(req.headers.cookie);
          return send(303, { Location: '/login', 'Set-Cookie': auth.cleared() });
        }
        if (!current && path !== '/style.css') {
          if (path.startsWith('/api/')) return send(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify({ error: '請先登入。' }));
          return send(303, { Location: '/login' });
        }
        if (current) viewer = { name: current.name, remote: true, role: current.role, canManage: current.role === 'referee', session: current.id };
      }

      // 人員名單與登入裝置：主控電腦與最高權限（主裁判／總召）可以查看、新增、停用、撤銷。
      if (path === '/api/sessions' || path === '/api/sessions/revoke' || path === '/api/people') {
        const reply = (status, value) => send(status, jsonHeaders, JSON.stringify(value));
        if (!auth || !viewer.canManage) return reply(403, { error: '只有主控電腦、主裁判或總召可以管理人員與登入裝置。' });
        const listing = (extra = {}) => ({ sessions: auth.list(), people: auth.people(), viewCode: access.viewCode, current: viewer.session ?? '', ...extra });
        if (path === '/api/sessions' && req.method === 'GET') return reply(200, listing());
        if (req.method !== 'POST') return reply(405, { error: '不支援的操作。' });
        if (!sameOrigin || !req.headers['content-type']?.startsWith('application/json')) return reply(403, { error: '請從本站操作。' });
        let input = {};
        try { input = JSON.parse(body.toString('utf8')) ?? {}; } catch {}
        if (path === '/api/sessions/revoke') {
          if (!auth.revoke(input.id)) return reply(404, { error: '找不到這個登入，可能已經登出。' });
          console.log(`撤銷登入：${input.id}（由 ${viewer.name}）`);
          return reply(200, listing());
        }
        const result = input.action === 'create' ? auth.createPerson(input.name, input.role, viewer.name)
          : input.action === 'disable' ? auth.setActive(input.id, false)
          : input.action === 'enable' ? auth.setActive(input.id, true)
          : input.action === 'regenerate' ? auth.regenerate(input.id)
          : { error: '不支援的操作。' };
        if (result.error) return reply(400, { error: result.error });
        console.log(`人員名單：${input.action} ${result.person.name}（由 ${viewer.name}）`);
        return reply(200, listing({ changed: { id: result.person.id, code: result.person.code } }));
      }

      // 音效檔：登入後（或本機）任何權限都可以取得。
      const sound = /^\/sounds\/(start|resume|warning|end)\.mp3$/.exec(path);
      if (sound) {
        const data = sounds.get(sound[1]);
        return data ? send(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400', 'Content-Length': data.length }, data) : send(404);
      }
      const headers = { ...req.headers };
      delete headers.cookie;
      const request = new Request(origin + req.url, {
        method: req.method,
        headers,
        ...(body.length > 0 ? { body } : {}),
      });
      const response = await worker.fetch(request, { DB, viewer });
      send(response.status, Object.fromEntries(response.headers), Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(500, textHeaders, '伺服器暫時無法處理請求。');
      else res.end();
    }
  };
}

const servers = [];
function listen(listenPort, isPublic, message) {
  const server = createServer(handler(isPublic));
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `連接埠 ${listenPort} 已被使用。可改設 ${isPublic ? 'PUBLIC_PORT' : 'PORT'} 後再啟動。` : err);
    process.exit(1);
  });
  server.listen(listenPort, '127.0.0.1', message);
  servers.push(server);
}

listen(port, false, () => {
  console.log(`賽務控制台已啟動：http://127.0.0.1:${port}（本機免登入）`);
  console.log(`資料：${dbFile}`);
  console.log(`備份：${backupDir}`);
});
if (publicPort) listen(publicPort, true, () => {
  console.log(`Tailscale 專用埠：127.0.0.1:${publicPort}（每個請求都要登入）`);
  console.log(`  檢視通行碼（共用，只能看）：${access.viewCode}　（${access.source}）`);
  const active = auth.people().filter((p) => p.active);
  console.log(`  個人通行碼：${active.length} 人啟用中（計分 ${active.filter((p) => p.role === 'edit').length}、主裁判／總召 ${active.filter((p) => p.role === 'referee').length}）`);
  if (!active.length) console.log(`  → 請在 http://127.0.0.1:${port} 的「人員與登入」頁建立工作人員的個人通行碼。`);
  if (access.ignored.length) console.log(`  注意：共用的計分／主裁判通行碼已停用，以下設定不再使用：${access.ignored.join('、')}`);
  console.log(`開放手機連線：tailscale funnel --bg --https=10000 ${publicPort}`);
});

function shutdown() {
  console.log('\n正在關閉，最後備份一次…');
  for (const server of servers) server.close();
  clearTimeout(backupTimer);
  if (dirty) safeBackup();
  database.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
