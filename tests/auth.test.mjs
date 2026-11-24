// 通行碼載入、個人通行碼名單、登入裝置（sessions）的單元測試。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAuth, loadAccess } from '../auth.mjs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const tempDir = () => mkdtempSync(join(tmpdir(), 'tel-auth-test-'));
const cookieOf = (login) => login.cookie.split(';')[0];
function freshAuth(viewCode = 'VIEW2026') {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return { db, auth: createAuth({ viewCode }, db) };
}

test('檢視通行碼：首次自動產生並保存；舊版共用碼回報為不再使用', () => {
  const dir = tempDir();
  try {
    const first = loadAccess(dir, {});
    assert.match(first.viewCode, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(loadAccess(dir, {}).viewCode, first.viewCode, '重啟後沿用');
    assert.equal(loadAccess(dir, { VIEW_CODE: 'look2026' }).viewCode, 'LOOK2026');
    writeFileSync(join(dir, 'access-code.txt'), 'oldcode1\n');
    assert.deepEqual(loadAccess(dir, { EDIT_CODE: 'x123456' }).ignored, ['EDIT_CODE', 'access-code.txt']);
    assert.throws(() => loadAccess(dir, { VIEW_CODE: 'abc' }), /6 個字元/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('舊版資料庫的 sessions 表會自動補上 person_id 欄位', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema.replace(',\n  person_id TEXT\n', '\n'));
  assert.ok(!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'person_id'));
  createAuth({ viewCode: 'VIEW2026' }, db);
  assert.ok(db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'person_id'));
});

test('攝影（直播字卡）通行碼可建立並登入', () => {
  const { auth } = freshAuth();
  const { person: camera } = auth.createPerson('攝影', 'camera', '本機');
  assert.equal(auth.identify(camera.code).role, 'camera');
  assert.equal(auth.people().find((p) => p.id === camera.id).roleLabel, '攝影（直播字卡）');
});

test('人員名單：建立、辨識、重新產生、停用', () => {
  const { auth } = freshAuth();
  const { person: scorer } = auth.createPerson('王小明', 'edit', '本機');
  const { person: chief } = auth.createPerson(' 林總召 ', 'referee', '本機');
  assert.equal(chief.name, '林總召');
  assert.notEqual(scorer.code, chief.code);
  assert.match(auth.createPerson('王小明', 'edit', '本機').error, /已有/);
  assert.match(auth.createPerson('', 'edit', '本機').error, /姓名/);
  assert.match(auth.createPerson('某人', 'view', '本機').error, /權限/);

  assert.deepEqual(auth.identify(scorer.code.toLowerCase()).person.name, '王小明');
  assert.equal(auth.identify(chief.code).role, 'referee');
  assert.deepEqual(auth.identify('VIEW2026'), { role: 'view', person: null });
  assert.equal(auth.identify('NOPE1234'), null);

  const old = scorer.code;
  const { person: renewed } = auth.regenerate(scorer.id);
  assert.notEqual(renewed.code, old);
  assert.equal(auth.identify(old), null, '舊通行碼失效');
  assert.equal(auth.identify(renewed.code).person.id, scorer.id);

  auth.setActive(scorer.id, false);
  assert.equal(auth.identify(renewed.code), null, '停用後無法登入');
  assert.match(auth.createPerson('王小明', 'edit', '本機').error ?? '', /^$/, '停用後可以建立同名的新人');
  assert.match(auth.setActive(scorer.id, true).error, /啟用中/, '同名已啟用時不能重新啟用舊的');
  const listed = auth.people();
  assert.equal(listed.length, 3);
  assert.deepEqual(listed.map((p) => p.active), [false, true, true]);
});

test('登入裝置：姓名由名單帶入；停用、重新產生、撤銷、登出都會讓登入失效', () => {
  const { auth } = freshAuth();
  const { person } = auth.createPerson('計分 A', 'edit', '本機');
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1';
  const a = auth.login(auth.identify(person.code), '冒名', '203.0.113.1', iphone);
  assert.equal(a.name, '計分 A', '個人碼忽略自己填的姓名');
  const cookie = cookieOf(a);
  assert.deepEqual({ ...auth.session(cookie), id: undefined }, { id: undefined, name: '計分 A', role: 'edit', personId: person.id });
  const viewer = cookieOf(auth.login(auth.identify('VIEW2026'), '觀摩新生', '203.0.113.2', ''));
  assert.equal(auth.session(viewer).name, '觀摩新生');
  assert.deepEqual(auth.list().map((s) => s.agent).sort(), ['iPhone · Safari', '未知裝置']);

  auth.regenerate(person.id);
  assert.equal(auth.session(cookie), null, '重新產生後舊登入失效');
  const second = cookieOf(auth.login(auth.identify(auth.people()[0].code), '', '', ''));
  auth.setActive(person.id, false);
  assert.equal(auth.session(second), null, '停用後登入失效');
  auth.setActive(person.id, true);
  assert.equal(auth.session(second).name, '計分 A', '重新啟用後恢復');

  assert.equal(auth.revoke(auth.list().find((s) => s.name === '觀摩新生').id), true);
  assert.equal(auth.session(viewer), null);
  auth.logout(second);
  assert.equal(auth.session(second), null);
  assert.equal(auth.session('tel_session=' + 'A'.repeat(43)), null);
});

test('更換檢視通行碼：舊的檢視登入失效，個人通行碼不受影響', () => {
  const { db, auth } = freshAuth('VIEW2026');
  const { person } = auth.createPerson('主裁判', 'referee', '本機');
  const viewer = cookieOf(auth.login(auth.identify('VIEW2026'), 'x', '', ''));
  const chief = cookieOf(auth.login(auth.identify(person.code), '', '', ''));
  const rotated = createAuth({ viewCode: 'LOOK2027' }, db);
  assert.equal(rotated.session(viewer), null);
  assert.equal(rotated.session(chief).role, 'referee');
});

test('舊版共用的計分／主裁判登入一律失效', () => {
  const { db, auth } = freshAuth();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO sessions (id, token_hash, name, role, code_print, ip, agent, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('old1', 'x'.repeat(64), 'Shaun', 'referee', 'abcd', '', '', now, now, Math.floor(Date.now() / 1000) + 3600);
  assert.equal(auth.list().length, 0);
});

test('輸錯次數只限制單一來源', () => {
  const { auth } = freshAuth();
  for (let i = 0; i < 100; i++) auth.fail('198.51.100.' + (i % 50));
  assert.equal(auth.allowed('198.51.100.1'), true, '每個來源只錯 2 次');
  for (let i = 0; i < 29; i++) auth.fail('192.0.2.9');
  assert.equal(auth.allowed('192.0.2.9'), true, '29 次仍可登入（校園 Wi-Fi 共用 IP）');
  auth.fail('192.0.2.9');
  assert.equal(auth.allowed('192.0.2.9'), false);
  assert.equal(auth.allowed('192.0.2.10'), true, '其他工作人員不受影響');
});
