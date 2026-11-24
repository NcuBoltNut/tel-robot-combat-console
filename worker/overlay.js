// 直播字卡（攝影通行碼登入後直接滿版顯示；工作人員也可開 /overlay 預覽）。只讀 /api/public。
// 版面：上排場次名稱；中排 藍方隊名｜藍方分數｜計時｜紅方分數｜紅方隊名；下排雙方計分拆解。
// 背景預設為綠幕（OBS 去背用），網址加 ?bg=none 為透明、?bg=dark 為深色。
// 此函式會以 toString() 送到瀏覽器，因此不可引用外部變數。
export function overlay(timing, event) {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const bg = new URLSearchParams(location.search).get('bg');
  document.body.classList.add('ov-bg-' + (['none', 'dark'].includes(bg) ? bg : 'green'));
  let revision = -1, data = null;
  let timer = { version: -1, mode: 'idle' }, timerAt = 0;
  const elapsed = () => Math.min(timer.duration * 1000, timer.elapsedMs + (timer.running ? performance.now() - timerAt : 0));

  // 要顯示哪一場：正在計時的 → 比賽中 → 計分中（暫定）→ 下一場 → 最後公布的一場。
  function current() {
    if (!data) return null;
    const order = (m) => data.events.findIndex((e) => e.id === m.id);
    const all = [...data.ranking, ...data.knockout].filter((m) => !m.skipped).sort((a, b) => order(a) - order(b));
    // 正在準備／比賽的那一場優先；其次是主審指定在場上的場次（維修計時是上一場勝隊的，不算）。
    const timed = ['prep', 'match'].includes(timer.mode) ? all.find((m) => m.id === timer.matchId) : null;
    const field = timer.field ? all.find((m) => m.id === timer.field) : null;
    return timed ?? field ?? all.filter((m) => m.state === '比賽中').at(-1) ?? all.find((m) => m.state === '計分中')
      ?? all.find((m) => m.state === '未開始') ?? all.filter((m) => m.state === '已公布').at(-1) ?? all[0] ?? null;
  }
  const scoreOf = (m, side) => (side === 'A' ? m.scoreA : m.scoreB) || String((side === 'A' ? m.cardA : m.cardB)?.total ?? 0);
  const detail = (card, knockout) => {
    if (!card) return '<span>尚未計分</span>';
    const parts = [['九宮格', card.base], ['小洞', card.bonus], ...(knockout ? [['連線', card.connectionPoints]] : []), ...(card.yellow ? [['黃牌', '−' + card.yellow]] : [])];
    return parts.map(([k, v]) => `<span><small>${esc(k)}</small>${esc(v)}</span>`).join('') + (card.outcome ? `<span class="ov-flag">${esc(card.outcome)}</span>` : '');
  };

  function render() {
    const m = current();
    if (!m) { $('ov').innerHTML = ''; return; }
    const knockout = m.match === 'knockout';
    const all = [...data.ranking, ...data.knockout].filter((x) => !x.skipped);
    const index = all.findIndex((x) => x.id === m.id) + 1;
    const title = knockout ? m.title : '排名賽 · ' + m.teamA;
    const nameA = m.teamA || (m.slotA ? m.slotA : '待確認');
    // 排名賽只有一隊：紅方位置顯示其他場次已確認成績中的最高分（名次要等全部確認後才自動帶入）。
    const leader = knockout ? null : data.ranking.filter((x) => x.id !== m.id && x.state === '已公布' && x.scoreA !== '')
      .sort((a, b) => Number(b.scoreA) - Number(a.scoreA))[0] ?? null;
    const nameB = knockout ? (m.teamB || m.slotB || '待確認') : leader ? leader.teamA : '排名賽';
    const scoreB = knockout ? scoreOf(m, 'B') : leader ? leader.scoreA : '';
    const tag = m.state === '已公布' ? '已確認' : m.provisional ? '暫定' : m.state;
    $('ov').innerHTML = `
      <div class="ov-top"><div class="ov-brand">${esc(event.brand)}<small>${esc(event.year)}</small></div>
        <div class="ov-title">${esc(title)}<span class="ov-tag">${esc(tag)}</span></div><div class="ov-brand ov-brand-r">${esc(event.overlayRight)}<small>${esc(event.overlayRightSmall)}</small></div></div>
      <div class="ov-main">
        <div class="ov-team ov-blue"><strong>${esc(nameA)}</strong><div class="ov-detail">${detail(m.cardA, knockout)}</div></div>
        <div class="ov-score ov-blue-score">${esc(scoreOf(m, 'A'))}</div>
        <div class="ov-clock"><strong id="ov-time">—:—</strong><div class="ov-sub"><span id="ov-phase"></span><span>${index} / ${all.length}</span></div></div>
        <div class="ov-score ov-red-score${knockout ? '' : ' ov-muted'}">${esc(scoreB)}</div>
        <div class="ov-team ov-red${knockout ? '' : ' ov-muted'}"><strong>${esc(nameB)}</strong><div class="ov-detail">${knockout ? detail(m.cardB, true) : leader ? '<span>目前最高分（已確認）</span>' : '<span>單隊投球計分</span>'}</div></div>
      </div>`;
    paintTimer();
  }
  // 比賽音效：OBS 的瀏覽器來源可以直接播放（音量在 OBS 混音器調整）；一般瀏覽器點一下畫面後才會出聲。
  const cue = timing.cueTracker();
  const audio = Object.fromEntries(['start', 'resume', 'warning', 'end'].map((name) => [name, new Audio('/sounds/' + name + '.mp3')]));
  document.addEventListener('pointerdown', () => { for (const a of Object.values(audio)) { a.muted = true; a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }, () => { a.muted = false; }); } }, { once: true });
  // 計時：只顯示這一場的計時；別場在計時（例如維修）時顯示該場名稱。
  function paintTimer() {
    const played = cue(timer, elapsed());
    if (played) { const a = audio[played]; a.currentTime = 0; a.play().catch(() => {}); }
    const time = $('ov-time'), phase = $('ov-phase');
    if (!time) return;
    const m = current();
    const d = timing.modes[timer.mode] ? timing.describe(timer, elapsed(), null) : null;
    const mine = d && m && timer.matchId === m.id;
    if (!d || (!mine && timer.mode !== 'repair')) { time.textContent = '3:00'; phase.textContent = m?.state === '已公布' ? '比賽結束' : '等待開始'; return; }
    time.textContent = d.clock;
    const e = elapsed();
    phase.textContent = timer.mode === 'prep' ? '調整準備'
      : timer.mode === 'repair' ? '晉級隊維修'
      : timer.finished ? '已完成' : d.over ? '時間到' : e < 60000 ? 'AI 自主 · ' + timing.clock(60000 - e) : '遙控';
    time.parentElement.dataset.tone = d.tone;
  }
  setInterval(paintTimer, 250);

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const res = await fetch('/api/public' + (revision >= 0 ? '?since=' + revision + '&t=' + timer.version : ''), { cache: 'no-store' });
      // 登入過期：一般瀏覽器回登入頁；OBS（有 window.obsstudio）不跳頁，免得直播畫面出現登入表單，
      // 保留最後畫面並標示離線，重新整理 OBS 來源（/obs/ 連結）就會自動重新登入。
      if (res.status === 401) { if (!window.obsstudio) { location.href = '/login'; return; } throw Error(); }
      if (res.status !== 204) {
        if (!res.ok) throw Error();
        data = await res.json();
        revision = data.revision;
        if (data.timer) { timer = data.timer; timerAt = performance.now(); }
        render();
      }
      document.body.classList.remove('ov-offline');
    } catch { document.body.classList.add('ov-offline'); } finally { polling = false; }
  }
  setInterval(poll, 500);
  poll();
}

export const overlayHtml = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>直播字卡</title><meta name="description" content="直播用比分字卡。"><link rel="stylesheet" href="/overlay.css"><script defer src="/overlay.js"></script></head>
<body class="ov-body"><div class="ov" id="ov" aria-live="polite"></div></body></html>`;

// 以視窗寬度（vw）定尺寸：任何解析度都滿版，比例固定。
export const overlayCss = `
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
.ov-body{font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",system-ui,sans-serif;display:flex;align-items:flex-end;justify-content:center}
.ov-bg-green{background:#00b140}.ov-bg-none{background:transparent}.ov-bg-dark{background:#0b1220}
.ov{width:100vw;padding:0 1.2vw 1.6vw;color:#fff}
.ov-top{display:grid;grid-template-columns:16vw 1fr 16vw;align-items:stretch;background:#121a27;border-radius:.8vw .8vw 0 0;overflow:hidden}
.ov-brand{background:#fff;color:#0f1b2d;font-weight:900;font-size:1.35vw;letter-spacing:.06em;display:flex;flex-direction:column;justify-content:center;align-items:center;line-height:1.05;padding:.5vw}
.ov-brand small{font-size:.9vw;letter-spacing:.3em;color:#53647c}
.ov-title{display:flex;align-items:center;justify-content:center;gap:1vw;font-size:1.9vw;font-weight:700;letter-spacing:.04em}
.ov-tag{font-size:1vw;font-weight:800;padding:.15vw .7vw;border-radius:99px;background:#f2c94c;color:#1d1600}
.ov-main{display:grid;grid-template-columns:1fr 9.5vw 15vw 9.5vw 1fr;height:8.6vw;border-radius:0 0 .8vw .8vw;overflow:hidden}
.ov-team{display:flex;flex-direction:column;justify-content:center;padding:0 2vw;min-width:0}
.ov-team strong{font-size:3.6vw;font-weight:900;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ov-blue{background:linear-gradient(90deg,#123d7a,#1f5fbf);align-items:flex-start}
.ov-red{background:linear-gradient(270deg,#7a1212,#c62828);align-items:flex-end;text-align:right}
.ov-score{display:grid;place-items:center;font-size:5vw;font-weight:900;font-variant-numeric:tabular-nums}
.ov-blue-score{background:#1f5fbf;box-shadow:inset -.25vw 0 0 #0d2c5a}.ov-red-score{background:#d32f2f;box-shadow:inset .25vw 0 0 #5a0d0d}
.ov-clock{background:#fff;color:#0f1b2d;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.2vw}
.ov-clock strong{font-size:4.2vw;font-weight:900;line-height:1;font-variant-numeric:tabular-nums}
.ov-clock[data-tone="auto"] strong{color:#b8860b}.ov-clock[data-tone="over"] strong,.ov-clock[data-tone="done"] strong{color:#c62828}.ov-clock[data-tone="paused"] strong{color:#7a8798}
.ov-sub{display:flex;gap:.6vw;font-size:1vw;font-weight:800}
.ov-sub span{background:#e8eef6;border-radius:.3vw;padding:.1vw .5vw}
.ov-detail{display:flex;gap:1.2vw;margin-top:.6vw;font-size:1.25vw;font-weight:800;font-variant-numeric:tabular-nums}
.ov-detail small{font-size:.85vw;font-weight:600;opacity:.8;margin-right:.3vw}
.ov-flag{background:#fff;color:#c62828;border-radius:.3vw;padding:0 .5vw}
.ov-muted{filter:saturate(.35) brightness(.8)}
.ov-offline .ov-clock{outline:.3vw solid #f2c94c}
`;
