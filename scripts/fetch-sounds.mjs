// 下載比賽音效到 sounds/（觀賽畫面、主審控制台、直播字卡共用）。
// 這四個檔是第三方音效（FRC 比賽場地音效，來源 myinstants.com），版權不屬於本專案，所以不放進 git。
// 用法：node scripts/fetch-sounds.mjs        要換別的音效：直接把 mp3 放到 sounds/ 並沿用下面的檔名即可。
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../sounds/', import.meta.url));
const files = {
  'start.mp3': 'https://www.myinstants.com/media/sounds/frc-start-sound.mp3',   // 開始（準備、比賽）
  'resume.mp3': 'https://www.myinstants.com/media/sounds/frc-resume.mp3',      // 第 60 秒切換手動
  'warning.mp3': 'https://www.myinstants.com/media/sounds/frc-warning.mp3',    // 剩 30 秒
  'end.mp3': 'https://www.myinstants.com/media/sounds/frc-end.mp3',            // 時間到／按完成
};
mkdirSync(dir, { recursive: true });
for (const [name, url] of Object.entries(files)) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = Buffer.from(await res.arrayBuffer());
  // MP3 檔開頭是 ID3 標籤或 MPEG frame sync（0xFFEx）
  const ok = res.ok && (data.subarray(0, 3).toString() === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0));
  if (!ok) { console.error(`下載失敗：${name}（${res.status}）`); process.exitCode = 1; continue; }
  writeFileSync(dir + name, data);
  console.log(`已下載 ${name}（${data.length} bytes）`);
}
