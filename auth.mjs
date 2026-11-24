// Tailscale 專用埠的登入。
// ・每位工作人員一組個人通行碼（計分，或主裁判／總召＝最高權限），由名單管理，可單獨停用。
// ・另有一組共用的「檢視」通行碼給觀摩者，只能看。
// 登入狀態存在資料庫的 sessions 表，可以列出目前登入的裝置並單獨撤銷。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { event } from './worker/event.js';

export const ROLE_LABELS = { view: '檢視', camera: '攝影（直播字卡）', edit: '計分', referee: '主裁判／總召' };
const COOKIE = 'tel_session';
const SESSION_SECONDS = 16 * 3600;
const WINDOW_MS = 10 * 60 * 1000;
const FAILURES_PER_CLIENT = 30; // 校園 Wi-Fi 多人共用一個公網 IP，不能太低；8 位隨機碼仍無法暴力猜中。
const SEEN_UPDATE_MS = 60 * 1000;
// 去掉容易看錯的 0/O、1/I/L，方便口頭或白板公布。
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const normalizeCode = (value) => String(value ?? '').trim().toUpperCase();
const sha256 = (value) => createHash('sha256').update(value).digest();
const fingerprint = (code) => sha256('tel-code:' + code).toString('hex').slice(0, 16);
export const newCode = () => Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
export function cleanName(value) {
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.length >= 1 && name.length <= 30 ? name : '';
}

// 檢視通行碼：環境變數 VIEW_CODE 優先，其次是 access-codes.json，沒有就自動產生。
// 舊版的共用計分／主裁判通行碼已停用（改用個人通行碼），出現時回報在 ignored。
export function loadAccess(dataDir, env = process.env) {
  const file = join(dataDir, 'access-codes.json');
  let stored = {};
  if (existsSync(file)) {
    try { stored = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} 格式有誤，請修正或刪除後重新啟動。`); }
  }
  let viewCode = normalizeCode(env.VIEW_CODE);
  let source = '環境變數 VIEW_CODE';
  if (!viewCode) {
    viewCode = normalizeCode(stored.view);
    source = file;
    if (!viewCode) {
      viewCode = stored.view = newCode();
      source = file + '（新產生）';
      writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
    }
  }
  if (viewCode.length < 6) throw new Error('檢視通行碼至少需要 6 個字元。');
  const ignored = ['EDIT_CODE', 'REFEREE_CODE', 'ACCESS_CODE'].filter((name) => normalizeCode(env[name]));
  if (stored.edit || stored.referee) ignored.push('access-codes.json 裡的 edit／referee');
  if (existsSync(join(dataDir, 'access-code.txt'))) ignored.push('access-code.txt');
  return { viewCode, source, file, ignored };
}

function deviceLabel(agent = '') {
  const os = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Mac OS/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : '';
  const browser = /Line\//.test(agent) ? 'LINE' : /EdgA?\//.test(agent) ? 'Edge' : /SamsungBrowser/.test(agent) ? 'Samsung' : /CriOS|Chrome\//.test(agent) ? 'Chrome' : /FxiOS|Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ') || '未知裝置';
}

export function createAuth({ viewCode }, database) {
  // 舊版資料庫的 sessions 表沒有 person_id 欄位：補上。
  const columns = database.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!columns.includes('person_id')) database.exec('ALTER TABLE sessions ADD COLUMN person_id TEXT');

  const failures = new Map();
  const viewDigest = sha256(viewCode);
  const viewPrint = fingerprint(viewCode);
  const q = {
    insert: database.prepare('INSERT INTO sessions (id, token_hash, name, role, code_print, ip, agent, created_at, last_seen, expires_at, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    byToken: database.prepare('SELECT id, name, role, code_print, last_seen, expires_at, revoked_at, person_id FROM sessions WHERE token_hash = ?'),
    touch: database.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?'),
    revoke: database.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    sessions: database.prepare('SELECT id, name, role, code_print, ip, agent, created_at, last_seen, expires_at, revoked_at, person_id FROM sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen DESC'),
    prune: database.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    person: database.prepare('SELECT id, name, role, code, created_at, created_by, disabled_at FROM people WHERE id = ?'),
    people: database.prepare('SELECT id, name, role, code, created_at, created_by, disabled_at FROM people ORDER BY created_at, rowid'),
    activePeople: database.prepare('SELECT id, name, role, code FROM people WHERE disabled_at IS NULL'),
    insertPerson: database.prepare('INSERT INTO people (id, name, role, code, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
    setDisabled: database.prepare('UPDATE people SET disabled_at = ? WHERE id = ?'),
    setCode: database.prepare('UPDATE people SET code = ? WHERE id = ?'),
    codeTaken: database.prepare('SELECT 1 FROM people WHERE code = ?'),
  };
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  // 判斷登入是否仍有效：個人通行碼被停用、重新產生，或檢視通行碼更換後，舊的登入都會失效。
  function resolve(row) {
    if (!row || row.revoked_at || row.expires_at <= nowSeconds()) return null;
    if (row.person_id) {
      const person = q.person.get(row.person_id);
      if (!person || person.disabled_at || fingerprint(person.code) !== row.code_print) return null;
      return { id: row.id, name: person.name, role: person.role, personId: person.id };
    }
    // 沒有 person_id 的只可能是共用檢視碼；舊版共用的計分／主裁判登入一律失效。
    if (row.role !== 'view' || row.code_print !== viewPrint) return null;
    return { id: row.id, name: row.name, role: 'view', personId: '' };
  }

  // 只限制單一來源：某個 IP 一直猜錯，不會連帶擋住其他工作人員。
  const recent = (list, now) => list.filter((t) => now - t < WINDOW_MS);
  function allowed(client) {
    const mine = recent(failures.get(client) ?? [], Date.now());
    if (mine.length) failures.set(client, mine); else failures.delete(client);
    return mine.length < FAILURES_PER_CLIENT;
  }
  function fail(client) {
    const now = Date.now();
    failures.set(client, [...recent(failures.get(client) ?? [], now), now]);
  }
  const clear = (client) => failures.delete(client);

  // 依通行碼找出身分；所有通行碼都比對一次，比對時間固定。
  function identify(value) {
    const given = sha256(normalizeCode(value));
    let found = null;
    if (timingSafeEqual(given, viewDigest)) found = { role: 'view', person: null };
    for (const person of q.activePeople.all()) if (timingSafeEqual(given, sha256(person.code))) found = { role: person.role, person };
    return found;
  }

  const tokenFrom = (cookieHeader) => {
    const raw = String(cookieHeader ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(COOKIE + '='));
    const token = raw?.slice(COOKIE.length + 1) ?? '';
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
  };
  const tokenHash = (token) => sha256(token).toString('hex');

  // 個人通行碼：姓名由名單帶入；共用檢視碼：用登入時填的姓名（沒填就是「觀摩者」）。
  function login(identity, typedName, ip, agent) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const name = identity.person ? identity.person.name : cleanName(typedName) || '觀摩者';
    const print = identity.person ? fingerprint(identity.person.code) : viewPrint;
    q.prune.run(nowSeconds() - 86400);
    q.insert.run(randomBytes(4).toString('hex'), tokenHash(token), name, identity.role, print, ip, deviceLabel(agent), now, now, nowSeconds() + SESSION_SECONDS, identity.person?.id ?? null);
    return { name, cookie: `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}` };
  }
  const cleared = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  function session(cookieHeader) {
    const token = tokenFrom(cookieHeader);
    if (!token) return null;
    const row = q.byToken.get(tokenHash(token));
    const current = resolve(row);
    if (current && Date.now() - Date.parse(row.last_seen) > SEEN_UPDATE_MS) q.touch.run(new Date().toISOString(), row.id);
    return current;
  }
  function logout(cookieHeader) {
    const token = tokenFrom(cookieHeader);
    const row = token && q.byToken.get(tokenHash(token));
    if (row) q.revoke.run(new Date().toISOString(), row.id);
  }
  const list = () => q.sessions.all(nowSeconds()).map((row) => [row, resolve(row)]).filter(([, current]) => current)
    .map(([row, current]) => ({ id: row.id, name: current.name, role: current.role, roleLabel: ROLE_LABELS[current.role], personId: current.personId,
      ip: row.ip, agent: row.agent, createdAt: row.created_at, lastSeen: row.last_seen }));
  const revoke = (id) => typeof id === 'string' && q.revoke.run(new Date().toISOString(), id).changes === 1;

  // ── 人員名單 ──
  const people = () => q.people.all().map((p) => ({ id: p.id, name: p.name, role: p.role, roleLabel: ROLE_LABELS[p.role], code: p.code,
    active: !p.disabled_at, createdAt: p.created_at, createdBy: p.created_by }));
  function uniqueCode() {
    for (;;) {
      const code = newCode();
      if (code !== viewCode && !q.codeTaken.get(code)) return code;
    }
  }
  function createPerson(rawName, role, by) {
    const name = cleanName(rawName);
    if (!name) return { error: '請填寫 1 到 30 字的姓名或職務。' };
    if (!['camera', 'edit', 'referee'].includes(role)) return { error: '權限只能是攝影、計分或主裁判／總召。' };
    if (q.activePeople.all().some((p) => p.name === name)) return { error: `名單上已有「${name}」。` };
    const person = { id: randomBytes(4).toString('hex'), name, role, code: uniqueCode() };
    q.insertPerson.run(person.id, name, role, person.code, new Date().toISOString(), by);
    return { person };
  }
  function setActive(id, active) {
    const person = typeof id === 'string' && q.person.get(id);
    if (!person) return { error: '找不到這個人。' };
    if (active && q.activePeople.all().some((p) => p.name === person.name)) return { error: `名單上已有啟用中的「${person.name}」。` };
    q.setDisabled.run(active ? null : new Date().toISOString(), id);
    return { person: { ...person, active } };
  }
  function regenerate(id) {
    const person = typeof id === 'string' && q.person.get(id);
    if (!person) return { error: '找不到這個人。' };
    const code = uniqueCode();
    q.setCode.run(code, id);
    return { person: { ...person, code } };
  }

  function loginPage(error = '') {
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登入 · ${esc(event.name)} 賽務控制台</title><link rel="stylesheet" href="/style.css"></head><body>
<div class="login"><div class="kicker"><span></span> ${esc(event.brand)} ${esc(event.year)}</div><h1>賽務控制台登入</h1>
<p>工作人員請輸入總召發給你的<strong>個人通行碼</strong>，姓名與權限會自動帶入。觀摩者請輸入檢視通行碼並填寫姓名。</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login">
<label>通行碼<input name="code" type="password" required autocomplete="current-password" autocapitalize="characters" spellcheck="false"></label>
<label>姓名（使用檢視通行碼時填寫）<input name="name" maxlength="30" autocomplete="nickname"></label>
<button class="primary" type="submit">登入</button>
</form></div></body></html>`;
  }

  return { allowed, fail, clear, identify, login, cleared, session, logout, list, revoke, people, createPerson, setActive, regenerate, loginPage };
}
