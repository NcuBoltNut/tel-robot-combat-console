// 觀賽畫面（檢視通行碼、或工作人員開 /watch 預覽／投影）。只讀 /api/public，沒有任何編輯功能。
// 此函式會以 toString() 送到瀏覽器，因此不可引用外部變數。
export function spectator(timing, event) {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let revision = -1;
  let data = null;
  // 計時：伺服器給已經過的毫秒數，這裡用單調時鐘往下數。
  let timer = { version: -1, mode: 'idle' }, timerAt = 0;
  const elapsed = () => Math.min(timer.duration * 1000, timer.elapsedMs + (timer.running ? performance.now() - timerAt : 0));
  const stallLeft = () => timer.stallMs == null ? null : Math.max(0, timing.STALL - (timer.stallMs + (timer.stallRunning ? performance.now() - timerAt : 0)));
  // 比賽音效：瀏覽器要求先點一下才能出聲，所以由觀眾按「開啟聲音」。
  const cue = timing.cueTracker();
  const audio = Object.fromEntries(['start', 'resume', 'warning', 'end'].map((name) => [name, new Audio('/sounds/' + name + '.mp3')]));
  let soundOn = false;
  async function toggleSound() {
    soundOn = !soundOn;
    if (soundOn) for (const a of Object.values(audio)) { a.muted = true; try { await a.play(); } catch {} a.pause(); a.currentTime = 0; a.muted = false; }
    const button = $('w-sound');
    if (button) button.textContent = soundOn ? '🔊 聲音開' : '🔇 開啟聲音';
  }
  document.addEventListener('click', (event) => { if (event.target.closest('#w-sound')) toggleSound(); });
  function paintTimer() {
    const played = cue(timer, elapsed());
    if (played && soundOn) { const a = audio[played]; a.currentTime = 0; a.play().catch(() => {}); }
    const card = $('w-timer');
    if (!card || !timing.modes[timer.mode]) return;
    const d = timing.describe(timer, elapsed(), stallLeft());
    card.dataset.tone = d.tone;
    $('w-label').textContent = d.label + (d.match ? ' · ' + d.match : '');
    $('w-clock').textContent = d.clock;
    $('w-sub').textContent = d.sub;
    $('w-stall').textContent = d.stall;
  }
  setInterval(paintTimer, 250);
  const timerCard = () => timing.modes[timer.mode]
    ? '<section class="watch-card watch-timer" id="w-timer" role="timer"><small id="w-label"></small><strong id="w-clock"></strong><span id="w-sub"></span><b id="w-stall"></b></section>' : '';

  const chip = (state) => `<span class="chip" data-state="${esc(state)}">${esc(state)}</span>`;
  const when = (item) => item.actual ? `${esc(item.actual)}<small class="orig">原訂 ${esc(item.time)}</small>` : esc(item.time);
  const side = (team, slot) => team ? esc(team) : `<span class="tbd">${esc(slot || '隊伍')}（待公布）</span>`;
  const vs = (m) => m.match === 'ranking' ? esc(m.teamA) : side(m.teamA, m.slotA) + ' <small>vs.</small> ' + side(m.teamB, m.slotB);

  function nowCard() {
    const matches = [...data.ranking, ...data.knockout].sort((a, b) => data.events.findIndex((e) => e.id === a.id) - data.events.findIndex((e) => e.id === b.id));
    // 正在調整準備／比賽的那一場優先（維修時間不算，那時下一場還沒開始）。
    const timed = ['prep', 'match'].includes(timer.mode) ? matches.find((m) => m.id === timer.matchId && m.state !== '已公布') : null;
    const field = timer.field ? matches.find((m) => m.id === timer.field && m.state !== '已公布') : null;
    const live = timed ?? field ?? matches.filter((m) => m.state === '比賽中').at(-1) ?? data.events.find((e) => e.status === '進行中');
    const next = matches.find((m) => m.state === '未開始' && m !== live);
    const line = (label, item) => item ? `<div class="now-line"><small>${label}</small><strong>${esc(item.title)}</strong><span>${item.match ? vs(item) : ''}</span><span class="time">${when(item)}</span></div>` : '';
    if (!live && !next) return '';
    return `<section class="watch-card now">${line('現在', live)}${line('下一場', next)}</section>`;
  }
  // 計分拆解：九宮格 ＋ 亮燈小洞 ＋ 連線 − 黃牌。
  function breakdown(card, knockout) {
    if (!card) return '';
    const parts = ['九宮格 ' + card.base, '小洞 ' + card.bonus, ...(knockout ? ['連線 ' + card.connectionPoints] : [])];
    return `<small class="breakdown">${esc(parts.join(' ＋ ') + (card.multiplier > 1 ? ' ×' + card.multiplier : '') + (card.yellow ? ' − 黃牌 ' + card.yellow : '') + (card.outcome ? ' · ' + card.outcome : ''))}</small>`;
  }
  // 即時計分看板：比賽中（或正在計時、剛結束計分中）的那一場，顯示九宮格、小洞與黃牌。
  function liveCard() {
    const matches = [...data.ranking, ...data.knockout];
    // 優先：正在計時的場次 → 最後一場「比賽中」→ 還在計分中的暫定成績。
    const live = (timing.modes[timer.mode] ? matches.find((m) => m.id === timer.matchId && m.state !== '已公布') : null)
      ?? (timer.field ? matches.find((m) => m.id === timer.field && m.state !== '已公布') : null)
      ?? matches.filter((m) => m.state === '比賽中').at(-1) ?? matches.find((m) => m.state === '計分中' && m.provisional);
    if (!live) return '';
    const knockout = live.match === 'knockout';
    const holes = ['左', '中', '右'];
    const sideBox = (name, slot, card, score) => {
      const grid = card?.grid ?? Array(9).fill(0);
      return `<article class="live-side"><header><strong>${side(name, slot)}</strong><span class="live-total">${esc(score || '0')}<small>${live.state === '已公布' ? '' : '暫定'}</small></span></header>
        <div class="mini-holes" aria-label="上方三個小洞">${holes.map((h, i) => {
          const lit = live.target === String(i + 1);
          return `<span class="${lit ? 'lit' : ''}">${lit ? '💡 ' + (card?.lit ?? 0) : h}</span>`;
        }).join('')}</div>
        <div class="mini-grid" aria-label="九宮格入網球數">${grid.map((n) => `<span class="${n ? 'hit' : ''}">${n}</span>`).join('')}</div>
        <div class="live-facts">${card ? `<span>九宮格 <b>${card.base}</b></span><span>亮燈小洞 <b>${card.bonus}</b></span>${knockout ? `<span>連線 <b>${card.connectionPoints}</b>（${card.connectionCount} 條）</span>` : ''}<span>入網 <b>${card.net}</b></span>${card.hole ? `<span>小洞不計分 <b>${card.hole}</b></span>` : ''}${card.yellow ? `<span>黃牌 <b>${card.yellow}</b></span>` : ''}<span>救援卡 <b>${card.rescue}</b></span>${card.outcome ? `<span><b>${esc(card.outcome)}</b></span>` : ''}` : '<span>尚未進球</span>'}</div></article>`;
    };
    return `<section class="watch-card live-board"><h2>即時計分<small>${esc(live.title)} · ${esc(live.state)}</small></h2>
      <div class="live-sides">${sideBox(live.teamA, live.slotA, live.cardA, live.scoreA)}${knockout ? sideBox(live.teamB, live.slotB, live.cardB, live.scoreB) : ''}</div>
      <p class="caption">分數由計分員點擊即時更新，為暫定成績；以主裁判確認後公布為準。</p></section>`;
  }
  function championCard() {
    return data.champion ? `<section class="watch-card champion"><small>${esc(event.name)} 冠軍</small><strong>🏆 ${esc(data.champion)}</strong></section>` : '';
  }
  function rankingCard() {
    const confirmed = data.ranking.filter((m) => m.rank).sort((a, b) => Number(a.rank) - Number(b.rank));
    const waiting = data.ranking.filter((m) => !m.rank);
    const rows = [
      ...confirmed.map((m) => `<li class="ranked"><span class="place">第 ${esc(m.rank)} 名</span><strong>${esc(m.teamA)}${breakdown(m.cardA, false)}</strong><span class="score">${esc(m.scoreA)} 分</span></li>`),
      ...waiting.map((m) => `<li><span class="place">—</span><strong>${esc(m.teamA)}${breakdown(m.cardA, false)}</strong>${m.provisional ? `<span class="score">${esc(m.scoreA)} 分 <span class="chip provisional">暫定</span></span>` : `<span>${when(m)} ${chip(m.state)}</span>`}</li>`),
    ];
    return `<section class="watch-card"><h2>上半場 · 排名賽</h2><p class="caption">${data.ranking.length === 5 ? '五' : '四'}隊單隊投球。比賽中的分數為暫定，名次以主裁判確認後公布。</p><ol class="ranking">${rows.join('')}</ol></section>`;
  }
  function bracketCard() {
    const team = (m, which) => {
      const name = which === 'A' ? m.teamA : m.teamB;
      const won = m.winner && m.winner === name;
      const score = which === 'A' ? m.scoreA : m.scoreB;
      return `<div class="side${won ? ' won' : ''}"><span>${side(name, which === 'A' ? m.slotA : m.slotB)}${breakdown(which === 'A' ? m.cardA : m.cardB, true)}</span><b>${esc(score)}</b></div>`;
    };
    const four = data.knockout.some((m) => m.skipped);
    return `<section class="watch-card"><h2>下半場 · 淘汰賽</h2>${four ? '<p class="caption">一隊未出賽，改採四隊賽制：第 1 名 vs. 第 4 名、第 2 名 vs. 第 3 名，不舉行附加賽。</p>' : ''}<div class="bracket">${data.knockout.filter((m) => !m.skipped).map((m) =>
      `<article class="match"><header><strong>${esc(m.title)}</strong>${m.provisional ? '<span class="chip provisional">暫定</span>' : ''}${chip(m.state)}</header>${team(m, 'A')}${team(m, 'B')}<small class="time">${when(m)}</small></article>`).join('')}</div></section>`;
  }
  function eventsCard() {
    return `<section class="watch-card"><h2>活動流程</h2><ol class="events">${data.events.filter((e) => e.period !== '活動前').map((e) =>
      `<li class="${e.status === '進行中' || e.status === '比賽中' ? 'live' : ''}"><span class="time">${when(e)}</span><span>${esc(e.title)}</span>${chip(e.status)}</li>`).join('')}</ol></section>`;
  }
  function render() {
    const viewer = data.viewer ?? {};
    const soundButton = `<button type="button" class="ghost" id="w-sound">${soundOn ? '🔊 聲音開' : '🔇 開啟聲音'}</button>`;
    $('watch-who').innerHTML = soundButton + (viewer.remote
      ? `<span>${esc(viewer.name)}</span>${viewer.role === 'view' ? '' : '<a class="ghost" href="/">回到控制台</a>'}<form method="post" action="/logout"><button class="ghost" type="submit">登出</button></form>`
      : '<span>主控電腦預覽</span><a class="ghost" href="/">回到控制台</a>');
    $('watch').innerHTML = timerCard() + liveCard() + championCard() + nowCard() + rankingCard() + bracketCard() + eventsCard();
  }
  // 0.5 秒輪詢：前一個請求還沒回來就不再送，避免舊回應蓋掉新資料。
  let polling = false;
  async function poll() {
    if (document.hidden || polling) return;
    polling = true;
    try {
      const res = await fetch('/api/public' + (revision >= 0 ? '?since=' + revision + '&t=' + timer.version : ''), { cache: 'no-store' });
      if (res.status === 401) { location.href = '/login'; return; }
      if (res.status !== 204) {
        if (!res.ok) throw Error();
        data = await res.json();
        revision = data.revision;
        if (data.timer) { timer = data.timer; timerAt = performance.now(); }
        render();
        paintTimer();
      }
      $('watch-sync').textContent = '更新於 ' + clock.format(new Date());
      $('watch-sync').classList.remove('offline');
    } catch {
      $('watch-sync').textContent = '連線中斷，自動重試中';
      $('watch-sync').classList.add('offline');
    } finally { polling = false; }
  }
  setInterval(poll, 500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
}
