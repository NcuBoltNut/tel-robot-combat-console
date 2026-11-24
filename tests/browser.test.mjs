// 前端實際操作測試：以 headless Chrome／Edge 開啟真正的 server.mjs（全新暫存資料）。
// 找不到瀏覽器時整份跳過；可用 CHROME_PATH 指定瀏覽器位置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPath, launchBrowser } from './helpers/browser.mjs';
import { startServer } from './helpers/server.mjs';

const skip = browserPath ? false : '找不到 Chrome 或 Edge（可設定 CHROME_PATH）';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
let browser;
let local;
const pages = [];

async function open(url, options) {
  const page = await browser.newPage(options);
  pages.push(page);
  await page.goto(url);
  return page;
}
const openLocal = async (options) => { const page = await open(local, options); await page.ready(); return page; };
// 模擬經 Tailscale 轉進專用埠的手機：每支手機用不同的來源 IP。
async function phone(name, code, ip, ready = '#view .panel, #view .cards') {
  const page = await open(`http://127.0.0.1:${server.publicPort}/`, { headers: { 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': ip }, mobile: true });
  assert.equal(await page.run(`return location.pathname`), '/login');
  await page.run(`document.querySelector('[name=code]').value=${JSON.stringify(code)};document.querySelector('[name=name]').value=${JSON.stringify(name)};setTimeout(()=>document.querySelector('form').submit(),0);`);
  await until(page, `return location.pathname==='/'&&!!document.querySelector(${JSON.stringify(ready)})`, 10000);
  return page;
}
// 在 Node 端反覆檢查（頁面可能正在換頁），直到條件成立；用於等待每 8 秒一次的自動同步。
async function until(page, check, ms = 12000) {
  for (let waited = 0; waited < ms; waited += 250) {
    try { const value = await page.run(check); if (value) return value; } catch {}
    await sleep(250);
  }
  throw new Error('等待逾時：' + check);
}
const openEdit = (id, mode = '') => `click('[data-tab="schedule"]');await sleep(30);
  click('[data-edit="${id}"][data-mode="${mode}"]');await waitFor(()=>$('editor').open);`;
const save = `click('#save');await sleep(50);await waitFor(()=>!$('save').disabled||!$('editor').open);await sleep(100);
  return {open:$('editor').open,error:$('edit-error').textContent,toast:$('toast').textContent};`;

test.before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await launchBrowser();
  local = `http://127.0.0.1:${server.port}/`;
});
test.after(async () => {
  await browser?.close();
  await server?.stop();
});

test('同一欄位衝突：保留輸入，再按一次儲存可覆蓋', { skip }, async () => {
  const a = await openLocal();
  const b = await openLocal();
  await a.run(openEdit('S03'));
  await b.run(openEdit('S03'));
  const first = await a.run(`setv('[name=notes]','A：改成 12:05');${save}`);
  assert.deepEqual([first.open, first.error], [false, '']);
  const conflict = await b.run(`setv('[name=notes]','B：延後五分鐘');setv('[name=actual]','12:05');${save}`);
  assert.equal(conflict.open, true);
  assert.match(conflict.error, /剛修改了：備註（目前為「A：改成 12:05」）/);
  assert.equal(await b.run(`return document.querySelector('[name=notes]').value`), 'B：延後五分鐘', '表單內容保留');
  const second = await b.run(save);
  assert.deepEqual([second.open, second.error], [false, '']);
  const record = await b.run(`return (await (await fetch('/api/state')).json()).records.find(r=>r.id==='S03')`);
  assert.deepEqual([record.notes, record.actual], ['B：延後五分鐘', '12:05']);
});

test('同一筆的不同欄位：兩人都能存', { skip }, async () => {
  const a = await openLocal();
  const b = await openLocal();
  await a.run(openEdit('S04'));
  await b.run(openEdit('S04'));
  assert.equal((await a.run(`setv('[name=status]','進行中');${save}`)).error, '');
  assert.equal((await b.run(`setv('[name=actual]','12:12');${save}`)).error, '');
  const record = await a.run(`return (await (await fetch('/api/state')).json()).records.find(r=>r.id==='S04')`);
  assert.deepEqual([record.status, record.actual], ['進行中', '12:12']);
});

test('自動同步：不按重新整理也會看到別人的修改；編輯中會提示', { skip }, async () => {
  const a = await openLocal();
  const b = await openLocal();
  await a.run(openEdit('S05'));
  await b.run(`${openEdit('S05')}setv('[name=actual]','12:20');${save}`);
  await until(a, `return $('edit-note').classList.contains('changed')&&/剛更新了這筆紀錄/.test($('edit-note').textContent)`);
  await a.run(`click('#cancel')`);
  await until(a, `return $('view').textContent.includes('12:20')`);
  assert.match(await a.run(`return $('sync').textContent`), /已同步/);
});

test('點擊式九宮格與上方小洞：+1、−1、復原、亮燈、上限提示，存檔後由伺服器算分', { skip }, async () => {
  const judge = await openLocal({ mobile: true });
  const tapA = (cell, times = 1) => `for(let i=0;i<${times};i++)document.querySelector('#cell-A${cell} .tap-main').click();`;
  const hole = (n, times = 1) => `for(let i=0;i<${times};i++)click('#hole-A${n}');`;
  const undoA = (times = 1) => `for(let i=0;i<${times};i++)click('.tap-undo[data-tap="A"]');`;
  const r = await judge.run(`${openEdit('K2', 'score')}
    const out={};const cnt=id=>$('cnt-'+id).textContent;const total=()=>$('score-A').textContent;
    ${tapA(0, 2)}${tapA(4, 2)}${tapA(8, 2)}
    out.diagonal=total();
    ${tapA(0)}out.over=$('note-A0').textContent;
    ${undoA()}out.undone=cnt('A0');
    ${hole(2)}out.firstHole={target:$('form').elements.target.value,lit:cnt('Alit'),on:$('hole-A2').classList.contains('lit'),total:total()};
    ${hole(1)}out.unlit={hole:cnt('Ahole'),lit:cnt('Alit'),total:total(),grid:cnt('A0')};
    ${hole(2, 2)}out.capped={lit:cnt('Alit'),note:$('hole-A2').textContent,total:total()};
    ${undoA(4)}out.undoAll={target:$('form').elements.target.value,lit:cnt('Alit'),hole:cnt('Ahole')};
    ${hole(2)}
    document.querySelector('#cell-B4 .tap-main').click();out.b=$('score-B').textContent;
    const big=document.querySelector('#cell-A4 .tap-main').getBoundingClientRect();out.size=[Math.round(big.width),Math.round(big.height)];
    out.scrollX=document.documentElement.scrollWidth<=innerWidth;
    setv('[name=resultStatus]','進行中');
    return {...out, ...(await (async()=>{${save}})())};`);
  assert.match(r.diagonal, /總分 20 .*九宮格 12 .*連線 8/, '對角線 3 格各 2 顆');
  assert.match(r.over, /超出 1 不計/);
  assert.equal(r.undone, '2');
  assert.deepEqual(r.firstHole, { target: '2', lit: '1', on: true, total: r.firstHole.total }, '第一次點的小洞就是亮燈小洞');
  assert.match(r.firstHole.total, /總分 24 .*亮燈小洞 4/, '亮燈小洞 4 分，不影響九宮格與連線');
  assert.deepEqual([r.unlit.hole, r.unlit.lit, r.unlit.grid], ['1', '1', '2'], '沒亮的小洞記為不計分，不會算進九宮格');
  assert.match(r.unlit.total, /總分 24 /);
  assert.equal(r.capped.lit, '3');
  assert.match(r.capped.note, /已計 2\/2.*超出 1 不計/);
  assert.match(r.capped.total, /總分 28 /, '下半場亮燈小洞最多計 2 顆');
  assert.deepEqual(r.undoAll, { target: '', lit: '0', hole: '0' }, '復原到選亮燈小洞之前');
  assert.match(r.b, /總分 2 /);
  assert.ok(r.size[0] >= 70 && r.size[1] >= 80, '手機上格子夠大：' + r.size);
  assert.equal(r.scrollX, true, '手機上沒有橫向捲動');
  assert.deepEqual([r.open, r.error], [false, '']);
  const saved = await judge.run(`const s=await (await fetch('/api/state')).json();const k=s.records.find(x=>x.id==='K2');const c=JSON.parse(k.cardA);return [k.scoreA,k.scoreB,k.target,c.grid.join(','),c.lit,c.hole];`);
  assert.deepEqual(saved, ['24', '2', '2', '2,0,0,0,2,0,0,0,2', 1, 0], '伺服器依明細算出得分');
});

test('計分：即時試算、確認、名次矛盾警告、修改歷史、CSV', { skip }, async () => {
  const judge = await openLocal();
  const r1 = await judge.run(`${openEdit('R1', 'score')}
    setv('[name=inputA0]','3');setv('[name=inputA1]','2');await sleep(30);const preview=$('score-A').textContent;
    setv('[name=rank]','1');setv('[name=resultStatus]','已確認');setv('[name=signoff]','主裁 王');
    return {preview, ...(await (async()=>{${save}})())};`);
  assert.match(r1.preview, /總分 10/);
  assert.deepEqual([r1.open, r1.error], [false, '']);

  // R2 分數比 R1 高卻填第 2 名 → 警告並要求備註
  const r2 = await judge.run(`${openEdit('R2', 'score')}
    setv('[name=inputA0]','3');setv('[name=inputA1]','3');setv('[name=inputA2]','3');setv('[name=rank]','2');
    setv('[name=resultStatus]','已確認');setv('[name=signoff]','主裁 王');await sleep(30);
    const warning=$('score-decision').textContent;const warn=$('score-decision').classList.contains('warn');
    return {warning, warn, ...(await (async()=>{${save}})())};`);
  assert.equal(r2.warn, true);
  assert.match(r2.warning, /計分順序不符.*中央 A/);
  assert.equal(r2.open, true);
  assert.match(r2.error, /計分備註/);
  const ruled = await judge.run(`setv('[name=scoreNotes]','中央 B 違規，主裁改判');${save}`);
  assert.deepEqual([ruled.open, ruled.error], [false, '']);

  const history = await judge.run(`${openEdit('R1', 'score')}
    $('history').open=true;$('history').dispatchEvent(new Event('toggle'));
    await waitFor(()=>$('history-list').querySelector('li'));const text=$('history-list').textContent;click('#cancel');return text;`);
  assert.match(history, /本機（主裁判／總召）/);
  assert.match(history, /A 方得分：（空白） → 10/);
  assert.match(history, /A 方計分明細：（空白） → 九宮格 3\/2\/0/);

  const csv = await judge.run(`click('[data-tab="results"]');await sleep(30);const link=document.querySelector('a[href="/api/export.csv"]');
    const res=await fetch(link.href);return {status:res.status,type:res.headers.get('content-type'),text:await res.text()};`);
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.match(csv.text, /R1,中央 A 單隊計分,.*,10,,1,,已確認,主裁 王/);
});

test('人員名單：在主控電腦建立個人通行碼；手機用個人碼登入；三種權限', { skip }, async () => {
  // 主控電腦用畫面新增兩個人
  const consolePage = await openLocal();
  const created = await consolePage.run(`click('[data-tab="devices"]');await waitFor(()=>$('person-name'));
    const viewCode=document.querySelector('.code').textContent;
    const add=async(name,role)=>{setv('#person-name',name);setv('#person-role',role);click('[data-person-create]');
      await waitFor(()=>[...document.querySelectorAll('#view tbody tr')].some(tr=>tr.textContent.includes(name)&&tr.querySelector('.code.inline')));
      return [...document.querySelectorAll('#view tbody tr')].find(tr=>tr.textContent.includes(name)).querySelector('.code.inline').textContent;};
    const scorer=await add('計分 A','edit');const chief=await add('林總召','referee');
    return {viewCode,scorer,chief,nameCleared:$('person-name').value===''};`);
  assert.equal(created.viewCode, server.viewCode);
  assert.match(created.scorer, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(created.nameCleared, true);

  // 檢視碼：直接進觀賽畫面，沒有任何後台元素
  const viewer = await phone('觀摩新生', server.viewCode.toLowerCase(), '203.0.113.11', '#watch .watch-card h2');
  const watch = await viewer.run(`return {title:document.title,who:$('watch-who').textContent,
    admin:!!document.querySelector('#nav, .filters, [data-edit], [data-add], #editor'),text:$('watch').textContent};`);
  assert.match(watch.title, /觀賽/);
  assert.match(watch.who, /觀摩新生/);
  assert.equal(watch.admin, false, '沒有導覽、篩選、編輯按鈕');
  assert.match(watch.text, /上半場 · 排名賽/);
  assert.match(watch.text, /下半場 · 淘汰賽/);
  assert.doesNotMatch(watch.text, /待確認/, '不出現後台用語');

  const scorer = await phone('冒名的人', created.scorer, '203.0.113.12');
  assert.match(await until(scorer, `return $('who').textContent`), /計分 A · 計分/, '姓名由名單帶入');
  const scored = await scorer.run(`${openEdit('R3', 'score')}
    const options=[...document.querySelectorAll('[name=resultStatus] option')].map(o=>o.textContent);
    const hint=$('edit-note').textContent;const reset=!!$('score-reset');setv('[name=inputA0]','2');setv('[name=resultStatus]','進行中');
    return {options, hint, reset, ...(await (async()=>{${save}})())};`);
  assert.ok(!scored.options.includes('已確認'), scored.options.join());
  assert.equal(scored.reset, false, '計分員沒有「分數歸零」');
  assert.match(scored.hint, /請主裁判確認/);
  assert.deepEqual([scored.open, scored.error], [false, '']);

  const chief = await phone('', created.chief, '203.0.113.13');
  assert.match(await until(chief, `return $('who').textContent`), /林總召 · 主裁判／總召/);
  const confirmed = await chief.run(`${openEdit('R3', 'score')}setv('[name=rank]','3');setv('[name=resultStatus]','已確認');setv('[name=signoff]','林總召');${save}`);
  assert.deepEqual([confirmed.open, confirmed.error], [false, '']);

  // 觀賽畫面自動更新：已確認的 R3 公布名次，其他場次不顯示暫定分數
  await until(viewer, `return $('watch').textContent.includes('第 3 名元智 A')`);
  const preview = await open(`http://127.0.0.1:${server.port}/watch`);
  await until(preview, `return /主控電腦預覽/.test($('watch-who').textContent)&&/第 3 名/.test($('watch').textContent)`);

  // 計分員按重新整理取得最新資料後，已確認的場次應為唯讀。
  const locked = await scorer.run(`click('#refresh');await sleep(500);${openEdit('R3', 'score')}
    const r={disabled:$('save').disabled,note:$('edit-note').textContent,taps:[...document.querySelectorAll('[data-tap]')].every(b=>b.disabled)};click('#cancel');return r;`);
  assert.equal(locked.disabled, true);
  assert.equal(locked.taps, true, '已確認的場次，九宮格按鈕全部鎖住');
  assert.match(locked.note, /只有主裁判/);

  // 總召在手機上：看得到名單與登入裝置；撤銷觀摩者；停用計分 A
  const managed = await chief.run(`click('[data-tab="devices"]');await waitFor(()=>document.querySelectorAll('#view tbody tr').length>=5);
    const masked=document.querySelectorAll('.code.inline').length===0;
    const sessions=[...document.querySelectorAll('[data-revoke]')].map(b=>b.dataset.revokeName);
    [...document.querySelectorAll('[data-revoke]')].find(b=>b.dataset.revokeName==='觀摩新生').click();
    await waitFor(()=>/已撤銷/.test($('toast').textContent));
    document.querySelector('[data-person-action="disable"][data-person-name="計分 A"]').click();
    await waitFor(()=>/已停用/.test($('toast').textContent));
    return {masked, sessions};`);
  assert.equal(managed.masked, true, '個人通行碼預設遮住');
  assert.deepEqual(managed.sessions.sort(), ['林總召', '觀摩新生', '計分 A'].sort());
  await until(viewer, `return location.pathname==='/login'`);
  await until(scorer, `return location.pathname==='/login'`);
  assert.match(await scorer.run(`document.querySelector('[name=code]').value=${JSON.stringify(created.scorer)};setTimeout(()=>document.querySelector('form').submit(),0);return true;`).then(() => sleep(1500)).then(() => scorer.run(`return document.body.textContent`)), /已被停用/);
});

test('比賽計時：主裁判開始比賽，底部計時條、觀賽畫面、計分視窗同步；完成後帶入用時', { skip }, async () => {
  const judge = await openLocal({ mobile: true });
  const watch = await open(local + 'watch', { mobile: true });
  const r = await judge.run(`click('[data-tab="timer"]');await sleep(50);
    const out={idle:$('tv-clock').textContent,bar:$('timer-bar').hidden};
    setv('#timer-match','R2');
    click('[data-timer="match"]');await waitFor(()=>$('tv-face').dataset.tone==='auto');await sleep(400);out.barOnTimerTab=$('timer-bar').hidden;
    out.clock=$('tv-clock').textContent;out.sub=$('tv-sub').textContent;out.tone=$('tv-face').dataset.tone;
    click('[data-tab="overview"]');await sleep(50);out.label=$('tb-label').textContent;out.barShown=!$('timer-bar').hidden;click('[data-tab="timer"]');await sleep(50);out.pauseShown=!document.querySelector('[data-timer="pause"]').hidden;
    out.scrollX=document.documentElement.scrollWidth<=innerWidth+1;
    const big=document.querySelector('[data-timer="match"]').getBoundingClientRect();out.size=Math.round(big.height);
    click('[data-timer="pause"]');await waitFor(()=>$('tv-face').dataset.tone==='paused');
    const a=$('tv-clock').textContent;await sleep(1300);out.pausedSame=a===$('tv-clock').textContent;
    out.resumeShown=!document.querySelector('[data-timer="resume"]').hidden;
    click('[data-timer="resume"]');await waitFor(()=>$('tv-face').dataset.tone==='auto');
    click('[data-timer="stall"]');await waitFor(()=>$('tv-stall').textContent!=='');out.stall=$('tv-stall').textContent;
    click('[data-timer="finish"]');await waitFor(()=>$('tv-face').dataset.tone==='done');out.done=$('tv-sub').textContent;
    return out;`);
  assert.deepEqual([r.idle, r.bar], ['—:—', true], '沒有計時時不顯示計時條');
  assert.equal(r.barOnTimerTab, true, '計時頁已有大鐘，不重複顯示底部計時條');
  assert.match(r.clock, /^(3:00|2:5\d)$/, '倒數以整秒無條件進位');
  assert.equal(r.tone, 'auto');
  assert.match(r.sub, /前 60 秒 · AI 自主控制 · 小洞亮燈中/);
  assert.match(r.label, /正式比賽 3 分鐘 · 中央 B 單隊計分 · 中央 B/);
  assert.equal(r.barShown, true, '其他分頁顯示底部計時條');
  assert.equal(r.pauseShown, true);
  assert.equal(r.pausedSame, true, '暫停後時間不走');
  assert.equal(r.resumeShown, true, '暫停時改顯示「繼續」');
  assert.match(r.stall, /機器人靜止 · 倒數 (30|29) 秒/);
  assert.match(r.done, /已完成 · 用時 0:0\d（\d 秒）/);
  assert.equal(r.scrollX, true, '手機上沒有橫向捲動');
  assert.ok(r.size >= 48, '手機上計時按鈕夠大：' + r.size);

  // 觀賽畫面在下一次輪詢（3 秒）內看到計時
  const seen = await until(watch, `const c=document.getElementById('w-timer');return c&&c.dataset.tone==='done'&&{tone:c.dataset.tone,sub:document.getElementById('w-sub').textContent,label:document.getElementById('w-label').textContent}`, 6000);
  assert.equal(seen.tone, 'done');
  assert.match(seen.label, /中央 B/);

  // 計分視窗：同一場顯示計時；排名賽可以一鍵帶入用時
  const e = await judge.run(`${openEdit('R2', 'score')}await sleep(300);
    const out={line:$('editor-timer').hidden?'':$('editor-timer').textContent,fill:$('fill-seconds').hidden?'':$('fill-seconds').textContent};
    click('#fill-seconds');await sleep(50);out.seconds=$('form').elements.inputAseconds.value;
    click('#cancel');
    ${openEdit('R3', 'score')}await sleep(300);out.other=$('editor-timer').hidden;click('#cancel');
    return out;`);
  assert.match(e.line, /^⏱ .*已完成 · 用時/);
  assert.match(e.fill, /^帶入計時 \d 秒$/);
  assert.match(e.seconds, /^\d$/);
  assert.equal(e.other, true, '別場不顯示這場的計時');

  const reset = await judge.run(`click('[data-tab="timer"]');await sleep(50);click('[data-timer="reset"]');await waitFor(()=>$('tv-face').dataset.tone==='idle');return $('tv-clock').textContent;`);
  assert.equal(reset, '—:—');
  await until(watch, `return !document.getElementById('w-timer')`, 6000);
});

test('即時計分：計分員點擊不必按儲存，觀賽畫面 0.5 秒內看到暫定分數與九宮格明細', { skip }, async () => {
  const judge = await openLocal({ mobile: true });
  const watch = await open(local + 'watch', { mobile: true });
  const r = await judge.run(`click('[data-tab="timer"]');await sleep(50);setv('#timer-match','R4');click('[data-timer="match"]');await waitFor(()=>$('tv-face').dataset.tone==='auto');
    ${openEdit('R4', 'score')}
    for(let i=0;i<2;i++)document.querySelector('#cell-A4 .tap-main').click();
    click('#hole-A3');
    await waitFor(()=>/已即時同步/.test($('draft-state').textContent),4000);
    return {note:$('draft-state').textContent,open:$('editor').open};`);
  assert.equal(r.open, true, '自動同步不會關掉計分視窗');
  const seen = await until(watch, `const b=document.querySelector('.live-board');return b&&/元智 B/.test(b.textContent)&&/8暫定/.test(b.textContent)&&{text:b.textContent,grid:[...b.querySelectorAll('.mini-grid span')].map(s=>s.textContent).join(','),lit:b.querySelector('.mini-holes .lit')?.textContent}`, 4000);
  assert.match(seen.text, /8暫定/, '九宮格 2 顆 4 分 ＋ 亮燈小洞 4 分 = 暫定 8 分');
  assert.equal(seen.grid, '0,0,0,0,2,0,0,0,0');
  assert.equal(seen.lit, '💡 1');
  // 再點一下就關掉視窗：關閉前會把最後一下送出
  await judge.run(`document.querySelector('#cell-A0 .tap-main').click();click('#cancel');await sleep(600);`);
  const ranking = await until(watch, `const li=[...document.querySelectorAll('.ranking li')].find(x=>/元智 B/.test(x.textContent));return li&&/10 分/.test(li.textContent)&&li.textContent`, 4000);
  assert.match(ranking, /暫定/);
  assert.match(ranking, /九宮格 6 ＋ 小洞 4/);
  const state = await judge.run(`const s=await (await fetch('/api/state')).json();const k=s.records.find(x=>x.id==='R4');return [k.scoreA,k.target,k.resultStatus||''];`);
  assert.deepEqual(state, ['10', '3', ''], '即時同步只送明細，不會自動確認成績');
  await judge.run(`click('[data-tab="timer"]');await sleep(50);click('[data-timer="reset"]');await waitFor(()=>$('tv-face').dataset.tone==='idle');`);
});

test('淘汰賽兩位計分員：互相看到對方的進球、沿用亮燈小洞；選了不同小洞時不會默默覆蓋，自己那一方照常同步', { skip }, async () => {
  const a = await openLocal({ mobile: true });
  const b = await openLocal({ mobile: true });
  const state = (id) => a.run(`const r=(await (await fetch('/api/state')).json()).records.find(x=>x.id==='${id}');return {target:r.target||'',A:r.cardA?JSON.parse(r.cardA):null,B:r.cardB?JSON.parse(r.cardB):null};`);
  const synced = `await waitFor(()=>/已即時同步|⚠/.test($('draft-state').textContent),4000);return $('draft-state').textContent;`;
  // K4：A 先選亮燈小洞並進球，B 的手機自動帶入，之後 B 點別的洞算「不計分」
  await a.run(openEdit('K4', 'score'));
  await b.run(openEdit('K4', 'score'));
  await a.run(`click('#hole-A2');document.querySelector('#cell-A4 .tap-main').click();${synced}`);
  const seen = await until(b, `return $('form').elements.target.value==='2'&&$('cnt-A4').textContent==='1'&&{lamp:$('hole-B2').textContent}`, 4000);
  assert.match(seen.lamp, /亮燈/, 'B 的手機沿用 A 選的亮燈小洞');
  await b.run(`click('#hole-B1');${synced}`);
  const k4 = await state('K4');
  assert.deepEqual([k4.target, k4.A.grid[4], k4.A.lit, k4.B.lit, k4.B.hole], ['2', 1, 1, 0, 1], 'B 點沒亮的洞記為不計分，A 的明細沒被蓋掉');
  await a.run(`click('#cancel')`);
  await b.run(`click('#cancel')`);
  // K3：兩人同時選了不同的亮燈小洞
  await a.run(openEdit('K3', 'score'));
  await b.run(openEdit('K3', 'score'));
  // 兩人在還沒看到對方之前就點：暫停兩支手機的輪詢（即時同步照常送出）
  const hold = `window.realFetch=window.fetch;window.fetch=(u,o)=>!o?.method&&String(u).startsWith('/api/state?')?Promise.resolve(new Response(null,{status:204})):window.realFetch(u,o);`;
  await Promise.all([a.run(hold), b.run(hold)]);
  await Promise.all([a.run(`click('#hole-A2');document.querySelector('#cell-A0 .tap-main').click();`), b.run(`click('#hole-B1');document.querySelector('#cell-B8 .tap-main').click();`)]);
  const notes = await Promise.all([a.run(synced), b.run(synced)]);
  await Promise.all([a.run(`window.fetch=window.realFetch;`), b.run(`window.fetch=window.realFetch;`)]);
  await sleep(800);
  const loser = /⚠/.test(notes[0]) ? a : b;
  assert.equal(notes.filter((n) => /⚠/.test(n)).length, 1, '其中一支手機看到不同亮燈小洞的提示：' + notes.join(' ／ '));
  assert.match(notes.find((n) => /⚠/.test(n)), /亮燈小洞（對方選「(左|中)」，你選「(左|中)」）/);
  const k2 = await state('K3');
  assert.deepEqual([k2.A?.grid[0], k2.B?.grid[8]], [1, 1], '被擋下的只有亮燈小洞，雙方九宮格都已同步');
  const winner = k2.target;
  // 被擋下的人繼續點，也不會自動蓋掉對方的亮燈小洞；按「儲存紀錄」核對後才覆蓋
  await loser.run(`document.querySelector('#cell-${loser === a ? 'A1' : 'B7'} .tap-main').click();await sleep(900);`);
  assert.equal((await state('K3')).target, winner, '自動同步不會覆蓋別人的亮燈小洞');
  const first = await loser.run(save);
  assert.match(first.error, /剛修改了：亮燈小洞/);
  assert.equal((await state('K3')).target, winner, '跳出提示時還沒覆蓋');
  // 看到提示後、決定之前又點了一下：以前這一下的自動同步會默默覆蓋
  await loser.run(`document.querySelector('#cell-${loser === a ? 'A2' : 'B6'} .tap-main').click();await sleep(900);`);
  assert.equal((await state('K3')).target, winner, '看到提示後再點，自動同步也不會覆蓋');
  await loser.run(`click('#cancel')`);
  await sleep(700);
  assert.equal((await state('K3')).target, winner, '按取消也不會覆蓋');
  await (loser === a ? b : a).run(`click('#cancel')`);
});

test('淘汰賽計分員先選「我負責」哪一方：對方縮成總分、按鈕鎖住，選擇會記住', { skip }, async () => {
  const consolePage = await openLocal();
  const code = await consolePage.run(`const res=await fetch('/api/people',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',name:'計分 B 方',role:'edit'})});return (await res.json()).changed.code;`);
  const scorer = await phone('', code, '203.0.113.31');
  const before = await scorer.run(`${openEdit('K1', 'score')}
    return {wait:!$('side-pick').classList.contains('need')?'':$('side-wait-note').textContent,
      locked:[...document.querySelectorAll('[data-tap]')].every(b=>b.disabled)};`);
  assert.match(before.wait, /請先在上方選「我負責」/);
  assert.equal(before.locked, true, '還沒選之前兩方都不能點');
  const picked = await scorer.run(`click('[data-side-pick="B"]');
    document.querySelector('#cell-A0 .tap-main').click();document.querySelector('#cell-B4 .tap-main').click();
    await waitFor(()=>/已即時同步/.test($('draft-state').textContent),4000);
    return {aOther:$('fs-A').classList.contains('side-other'),bMine:$('fs-B').classList.contains('side-mine'),
      aLocked:[...document.querySelectorAll('[data-tap="A"]')].every(b=>b.disabled),bOpen:!document.querySelector('#cell-B0 .tap-main').disabled,
      aGridHidden:getComputedStyle(document.querySelector('#fs-A .tap-grid')).display==='none',wait:$('side-wait-note').hidden};`);
  assert.deepEqual(picked, { aOther: true, bMine: true, aLocked: true, bOpen: true, aGridHidden: true, wait: true });
  const saved = await consolePage.run(`const k=(await (await fetch('/api/state')).json()).records.find(x=>x.id==='K1');return [k.cardA?JSON.parse(k.cardA).grid[0]:0,k.cardB?JSON.parse(k.cardB).grid[4]:0];`);
  assert.deepEqual(saved, [0, 1], '點不到 A 方，只記到 B 方');
  await scorer.run(`click('#cancel');setTimeout(()=>location.reload(),0);`);
  await sleep(500);
  await until(scorer, `return !!document.querySelector('#view .panel, #view .cards')&&!!document.querySelector('[data-tab="schedule"]')`);
  const remembered = await scorer.run(`${openEdit('K1', 'score')}
    const r=document.querySelector('[data-side-pick="B"]').getAttribute('aria-pressed');click('#cancel');return r;`);
  assert.equal(remembered, 'true', '重新整理後仍記得負責 B 方');
  const judge = await openLocal({ mobile: true });
  const both = await judge.run(`${openEdit('K1', 'score')}const r={pressed:document.querySelector('[data-side-pick="both"]').getAttribute('aria-pressed'),
    open:!document.querySelector('#cell-A0 .tap-main').disabled&&!document.querySelector('#cell-B0 .tap-main').disabled};click('#cancel');return r;`);
  assert.deepEqual(both, { pressed: 'true', open: true }, '主裁判預設兩方都能點');
});

test('主審指定上場：計分員的計分視窗自動跳到那一場；正在編輯別的資料時只提示', { skip }, async () => {
  const consolePage = await openLocal();
  const code = await consolePage.run(`const res=await fetch('/api/people',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',name:'跟場計分員',role:'edit'})});return (await res.json()).changed.code;`);
  const scorer = await phone('', code, '203.0.113.41');
  const field = (id) => consolePage.run(`const r=await fetch('/api/timer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'field',matchId:'${id}'})});return r.status;`);
  assert.equal(await field('R4'), 200);
  const first = await until(scorer, `return $('editor').open&&$('score-A')&&$('form').closest('dialog')&&document.querySelector('#editor legend')?.textContent`, 6000);
  assert.match(first, /元智 B/, '主審指定 R4（元智 B）後，計分視窗自動開到那一場');
  // 點一下再換場：前一場的點擊會先送出，不會漏（前面的測試可能已在 R4 記過球，以點擊前為基準）
  const r4Grid0 = `const s=await (await fetch('/api/state')).json();const c=s.records.find(x=>x.id==='R4').cardA;return c?JSON.parse(c).grid[0]:0;`;
  const before = await consolePage.run(r4Grid0);
  await scorer.run(`document.querySelector('#cell-A0 .tap-main').click();`);
  assert.equal(await field('R2'), 200);
  const second = await until(scorer, `const t=document.querySelector('#editor legend')?.textContent;return $('editor').open&&/中央 B/.test(t)&&t`, 6000);
  assert.match(second, /中央 B/, '換場後自動切到 R2');
  await sleep(800);
  assert.equal(await consolePage.run(r4Grid0), before + 1, '切換前的點擊已送出');
  // 正在編輯一般資料時，不強制跳走
  await scorer.run(`click('#cancel');await sleep(200);${openEdit('S03')}`);
  assert.equal(await field('R3'), 200);
  const toast = await until(scorer, `return /主審已指定/.test($('toast').textContent)&&$('toast').textContent`, 6000);
  assert.match(toast, /元智 A/);
  assert.equal(await scorer.run(`return $('editor').open&&!$('score-A');`), true, '仍停留在原本的編輯視窗');
  await scorer.run(`click('#cancel')`);
});

test('主審控制台：比賽音效預設開啟，開始比賽播 start、按完成播 end', { skip }, async () => {
  const judge = await openLocal();
  const r = await judge.run(`
    window.__played=[];const real=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){if(!this.muted)window.__played.push(this.src.split('/').pop());return real.call(this).catch(()=>{});};
    click('[data-tab="timer"]');await sleep(100);
    const checked=$('timer-sound').checked;
    setv('#timer-match','R2');click('[data-timer="match"]');
    await waitFor(()=>window.__played.includes('start.mp3'),4000);
    click('[data-timer="finish"]');
    await waitFor(()=>window.__played.includes('end.mp3'),4000);
    click('[data-timer="reset"]');await sleep(300);
    return {checked,played:window.__played};`);
  assert.equal(r.checked, true, '主審預設勾選比賽音效');
  assert.deepEqual(r.played, ['start.mp3', 'end.mp3']);
});

test('主審在成績頁移除場次、再復原', { skip }, async () => {
  const judge = await openLocal();
  const r = await judge.run(`click('[data-tab="results"]');await sleep(200);
    click('[data-remove="K4"]');
    await waitFor(()=>document.querySelector('[data-restore="K4"]'),4000);
    const removed={inGone:/已移除的場次（1）：冠軍賽/.test(document.querySelector('#view').textContent),timer:false};
    click('[data-tab="timer"]');await sleep(150);
    removed.timer=[...document.querySelectorAll('#timer-match option')].some(o=>o.value==='K4');
    click('[data-tab="results"]');await sleep(150);
    click('[data-restore="K4"]');
    await waitFor(()=>document.querySelector('[data-remove="K4"]'),4000);
    return {...removed,back:!document.querySelector('[data-restore="K4"]')};`);
  assert.deepEqual(r, { inGone: true, timer: false, back: true });
});

test('網路不穩：即時同步其實已寫入但沒收到回應，下一次同步不會誤報成別人修改', { skip }, async () => {
  const judge = await openLocal({ mobile: true });
  // 第一個即時同步送到伺服器（已寫入），但回應在路上斷掉
  const r = await judge.run(`${openEdit('R5', 'score')}
    const real=window.fetch;let dropped=false;
    window.fetch=async(u,o)=>{const res=await real(u,o);if(o?.method==='PUT'&&!dropped){dropped=true;throw new TypeError('Failed to fetch');}return res;};
    document.querySelector('#cell-A4 .tap-main').click();
    await waitFor(()=>/連線中斷/.test($('draft-state').textContent),4000);
    window.fetch=real;
    document.querySelector('#cell-A4 .tap-main').click();
    await waitFor(()=>/已即時同步|⚠/.test($('draft-state').textContent),4000);
    const note=$('draft-state').textContent;click('#cancel');return note;`);
  assert.match(r, /已即時同步/, '應該接著同步，不是跳出衝突提示：' + r);
  const record = await judge.run(`return (await (await fetch('/api/state')).json()).records.find(x=>x.id==='R5')`);
  assert.equal(JSON.parse(record.cardA).grid[4], 2, '兩次點擊都已寫入');
});

test('主裁判分數歸零：已確認的成績清回尚未計分，其他人的計分視窗跟著歸零，修改歷史保留', { skip }, async () => {
  const judge = await openLocal({ mobile: true });
  const other = await openLocal({ mobile: true });
  const before = await judge.run(`return (await (await fetch('/api/state')).json()).records.find(x=>x.id==='R3')`);
  assert.equal(before.resultStatus, '已確認', '前面的測試已確認 R3');
  await other.run(openEdit('R3', 'score'));
  const r = await judge.run(`${openEdit('R3', 'score')}
    let asked='';window.confirm=m=>{asked=m;return true;};
    click('#score-reset');await waitFor(()=>/已歸零/.test($('toast').textContent),4000);
    const out={asked,open:$('editor').open,cell:$('cnt-A0').textContent,status:$('form').elements.resultStatus.value,rank:$('form').elements.rank.value,
      preview:$('score-A').textContent,undo:document.querySelector('.tap-undo').disabled};
    click('#cancel');return out;`);
  assert.match(r.asked, /歸零/);
  assert.deepEqual([r.open, r.cell, r.status, r.rank, r.undo], [true, '0', '待確認', '', true], '視窗留著並顯示歸零後的內容');
  assert.match(r.preview, /待輸入球數/);
  const after = await judge.run(`return (await (await fetch('/api/state')).json()).records.find(x=>x.id==='R3')`);
  assert.deepEqual([after.cardA ?? '', after.scoreA ?? '', after.rank ?? '', after.signoff ?? '', after.resultStatus], ['', '', '', '', '待確認']);
  assert.equal(after.title, before.title, '其他欄位不受影響');
  await until(other, `return $('cnt-A0').textContent==='0'`, 4000);
  const history = await judge.run(`return (await (await fetch('/api/history?id=R3')).json()).history.filter(h=>h.field==='resultStatus').map(h=>h.before+'→'+h.after)`);
  assert.ok(history.includes('已確認→待確認'), history.join());
  await other.run(`click('#cancel')`);
});

test('手機版面：沒有水平捲動', { skip }, async () => {
  const page = await openLocal({ mobile: true });
  assert.equal(await page.run(`return document.documentElement.scrollWidth<=window.innerWidth+1`), true);
  assert.equal(await page.run(`${openEdit('K1', 'score')}const ok=document.documentElement.scrollWidth<=window.innerWidth+1;click('#cancel');return ok;`), true);
});

test('所有頁面都沒有 JavaScript 錯誤', { skip }, () => {
  const errors = pages.flatMap((page) => page.errors);
  assert.deepEqual(errors, []);
});
