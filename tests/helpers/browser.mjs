// 以 Chrome DevTools Protocol 操作本機的 Chrome／Edge（headless），不需要安裝任何套件。
// 每個 page 都在獨立的瀏覽器環境（各自的 cookie），模擬不同工作人員的手機。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
export const browserPath = candidates.find((path) => existsSync(path)) ?? null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'tel-browser-'));
  const proc = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank']);
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { await sleep(100); }
  }
  if (!port) throw new Error('瀏覽器沒有啟動');
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, method } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`)); else resolve(message.result);
    } else if (message.sessionId && listeners.has(message.sessionId)) listeners.get(message.sessionId)(message);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  async function newPage({ headers, mobile = false } = {}) {
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const errors = [];
    listeners.set(sessionId, (message) => {
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
      if (message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, sessionId);
    });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    if (headers) await send('Network.setExtraHTTPHeaders', { headers }, sessionId);
    if (mobile) await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);

    const page = {
      errors,
      // 在頁面中執行一段 async 函式內容；$、sleep、setv、waitFor 等小工具已預先定義。
      async run(body) {
        const prelude = `const $=id=>document.getElementById(id);const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const setv=(sel,v)=>{const el=document.querySelector(sel);if(!el)throw new Error('找不到 '+sel);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
const waitFor=async(test,ms=5000)=>{for(let t=0;t<ms;t+=50){const v=test();if(v)return v;await sleep(50);}throw new Error('等待逾時：'+test);};
const click=sel=>{const el=document.querySelector(sel);if(!el)throw new Error('找不到 '+sel);el.click();};`;
        const result = await send('Runtime.evaluate', { expression: `(async()=>{${prelude}\n${body}})()`, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      },
      async goto(url) {
        const loaded = new Promise((resolve) => {
          const previous = listeners.get(sessionId);
          listeners.set(sessionId, (message) => {
            previous(message);
            if (message.method === 'Page.loadEventFired') { listeners.set(sessionId, previous); resolve(); }
          });
        });
        await send('Page.navigate', { url }, sessionId);
        await loaded;
      },
      async screenshot(file, { fullPage = false } = {}) {
        const { writeFileSync } = await import('node:fs');
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage }, sessionId);
        writeFileSync(file, Buffer.from(data, 'base64'));
      },
      // 等前端第一次載入資料完成。
      async ready() {
        await page.run(`await waitFor(()=>document.querySelector('#view .panel, #view .cards'),10000);`);
      },
    };
    return page;
  }

  return {
    newPage,
    // 等瀏覽器行程真的結束（Windows 上會鎖住設定檔），再刪除暫存設定檔。
    async close() {
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((resolve) => proc.once('exit', resolve));
      try { await send('Browser.close'); } catch {}
      ws.close();
      await Promise.race([exited, sleep(5000)]);
      if (proc.exitCode === null) { proc.kill(); await Promise.race([exited, sleep(2000)]); }
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
    },
  };
}
