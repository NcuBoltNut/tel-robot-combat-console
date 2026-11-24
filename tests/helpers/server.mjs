// 以全新的暫存資料夾啟動 server.mjs，測試結束後刪除。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const testViewCode = 'VIEWCODE9';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

export async function startServer({ viewCode = testViewCode, env = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tel-console-test-'));
  const port = await freePort();
  const publicPort = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), PUBLIC_PORT: String(publicPort), DATA_DIR: dataDir,
      VIEW_CODE: viewCode, EDIT_CODE: '', REFEREE_CODE: '', ACCESS_CODE: '', ...env },
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('伺服器沒有啟動：' + output)), 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('本機免登入') && output.includes('專用埠')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`伺服器結束（${code}）：${output}`)); });
  });
  return {
    port, publicPort, dataDir, viewCode,
    // 透過主控電腦（本機埠）建立工作人員，回傳他的個人通行碼。
    async addPerson(name, role) {
      const res = await call(port, { method: 'POST', path: '/api/people', body: JSON.stringify({ action: 'create', name, role }),
        headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } });
      if (res.status !== 200) throw new Error(res.text);
      const data = JSON.parse(res.text);
      return { id: data.changed.id, code: data.changed.code };
    },
    output: () => output,
    // Windows 上行程結束前仍鎖著 SQLite 檔，要等它真的結束再刪資料夾。
    async stop() {
      if (child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export function call(targetPort, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: targetPort, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
