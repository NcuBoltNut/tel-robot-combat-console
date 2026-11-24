// 比賽計時的顯示規則（依 docs/2026_rule_0903.pdf）：調整準備 90 秒 → 正式比賽 3 分鐘（前 60 秒 AI 自主控制、小洞亮燈），
// 下半場勝隊於準備區維修 5 分鐘；比賽中機器人靜止時，裁判喊「倒數 30 秒」。
// 控制台與觀賽畫面共用。此函式會以 toString() 送到瀏覽器，因此不可引用外部變數。
export function telTimer() {
  const modes = { prep: ['調整準備 90 秒', 90], match: ['正式比賽 3 分鐘', 180], repair: ['晉級隊維修 5 分鐘', 300] };
  const actions = { prep: '開始調整準備 90 秒', match: '開始正式比賽 3 分鐘', repair: '開始晉級隊維修 5 分鐘', pause: '暫停', resume: '繼續',
    finish: '完成（記錄用時）', stall: '開始靜止倒數 30 秒', stallClear: '取消靜止倒數', reset: '重設計時', field: '指定上場' };
  const STALL = 30000;
  const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  // 已用秒數：未滿 1 秒以 1 秒計，最多到該段時間上限。
  const usedSeconds = (t, elapsed) => Math.min(t.duration, Math.ceil(Math.max(0, elapsed) / 1000));
  // t：伺服器給的計時狀態；elapsed：目前經過毫秒；stallLeft：靜止倒數剩餘毫秒（沒有時為 null）。
  function describe(t, elapsed, stallLeft = null) {
    if (!t || !modes[t.mode]) return null;
    const total = t.duration * 1000;
    const left = Math.max(0, total - elapsed);
    const over = left <= 0;
    const used = usedSeconds(t, elapsed);
    let sub, tone = 'run';
    if (t.mode === 'match') {
      if (t.finished) { sub = '已完成 · 用時 ' + clock(used * 1000) + '（' + used + ' 秒）'; tone = 'done'; }
      else if (over) { sub = '比賽時間到'; tone = 'over'; }
      else if (elapsed < 60000) { sub = '前 60 秒 · AI 自主控制 · 小洞亮燈中（' + clock(60000 - elapsed) + ' 後熄燈）'; tone = 'auto'; }
      else sub = '第 61 秒起 · 可切換遙控 · 小洞已熄燈，進小洞不計分';
    } else if (t.mode === 'prep') {
      sub = over ? '準備時間到 · 機器人放入起始框，開始比賽（未調整完也不暫停）' : '人員作業區調整、充填';
      if (over) tone = 'over';
    } else {
      sub = over ? '維修時間到 · 停止維修' : '晉級隊伍於準備區維修';
      if (over) tone = 'over';
    }
    if (!t.running && !over && !t.finished) { tone = 'paused'; sub = '⏸ 暫停中 · ' + sub; }
    const stall = t.mode !== 'match' || over || t.finished || stallLeft === null ? ''
      : stallLeft > 0 ? '機器人靜止 · 倒數 ' + Math.ceil(stallLeft / 1000) + ' 秒' : '靜止已滿 30 秒 · 須使用救援卡';
    const match = [t.title, (t.teams || []).filter(Boolean).join(' vs. ')].filter(Boolean).join(' · ');
    return { label: modes[t.mode][0], match, clock: clock(left), sub, tone, over, used, stall, left };
  }
  // 比賽音效：開始 → start、第 60 秒切換手動 → resume（只有正式比賽）、剩 30 秒 → warning、時間到或按完成 → end。
  // 調整準備 90 秒也用同一組（開始、剩 30 秒、時間到）；維修計時不播。
  // 只在「跨過」時間點時回傳一次；中途才打開畫面不補播。每個畫面各自建立一個。
  function cueTracker() {
    let last = null;
    return (t, elapsed) => {
      if (!t || !['match', 'prep'].includes(t.mode)) { last = null; return null; }
      const key = t.matchId + '|' + t.mode + '|' + t.duration, total = t.duration * 1000;
      const prev = last && last.key === key ? last : null;
      last = { key, elapsed, finished: Boolean(t.finished) };
      if (!prev || elapsed + 1500 < prev.elapsed) return elapsed < 1500 && !t.finished ? 'start' : null;
      if (t.finished && !prev.finished && prev.elapsed < total) return 'end';
      const crossed = (at) => prev.elapsed < at && elapsed >= at;
      if (crossed(total)) return 'end';
      if (crossed(total - 30000)) return 'warning';
      if (t.mode === 'match' && crossed(60000)) return 'resume';
      return null;
    };
  }
  return { modes, actions, STALL, clock, usedSeconds, describe, cueTracker };
}
