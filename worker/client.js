// 前端程式。此函式會以 toString() 送到瀏覽器，因此不可引用外部變數。
export function client({teams,periods,kinds,statuses,pending,event}, scoring, rules, clockRules) {
  const $ = id=>document.getElementById(id);
  const esc = value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const val = value=>esc(value||pending);
  const pill = status=>`<span class="pill" data-status="${esc(status||pending)}">${val(status)}</span>`;
  const opts = (items,value='',blank='請選擇')=>`<option value="">${esc(blank)}</option>`+items.map(v=>`<option${v===value?' selected':''}>${esc(v)}</option>`).join('');
  const links = {overview:['總覽','▦'],timer:['比賽計時','⏱'],schedule:['時程與隊別','◷'],teams:['隊伍與檢錄','♟'],board:['流程看板','▤'],staff:['人員與交接','☷'],results:['計分與影像','◎'],incidents:['異動與備案','◇'],devices:['人員與登入','⚿']};
  const roleLabels = {view:'檢視',camera:'攝影（直播字卡）',edit:'計分',referee:'主裁判／總召',system:'系統'};
  // 權限由伺服器判斷；這裡只決定要不要顯示按鈕。
  let viewer = {name:'',remote:false,role:'view',canManage:false,session:''};
  const canEdit = ()=>viewer.role!=='view';
  const canConfirm = ()=>viewer.role==='referee';
  let devices = null, devicesKey = '';
  const revealed = new Set();
  const personDraft = {name:'',role:'edit'};
  const titles = {schedule:'時程',team:'隊伍',staff:'人員',task:'任務',incident:'異動／備案',media:'影像索引'};
  const filters = {team:[teams,'全部隊伍'],period:[periods,'全部時段'],category:[kinds,'全部工作類別'],status:[statuses,'全部狀態']};
  const terminal = ['已完成','已確認','已結案','已檢錄'];
  // edited：編輯中的內容；original：開啟編輯器當下的資料庫版本（新增時為 null），用來算出這次實際改了哪些欄位。
  let tab='overview', revision=0, records=[], loaded=false, edited=null, original=null, saving=false, polling=false, toastTimer, teamOptionsKey='', updatedAt=null;
  const range = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const clock = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  Object.entries(filters).forEach(([id,[values,label]])=>{$(id).innerHTML=opts(values,'',label);$(id).onchange=render;});
  function selectTab(id) {tab=id;render();if(id==='timer')$('view').scrollIntoView();else window.scrollTo(0,0);if(id==='devices')loadDevices();}
  function toLogin() {location.href='/login';}
  function markSynced(ok=true) {
    $('sync').innerHTML=ok?esc(updatedAt?'已同步 · '+range.format(new Date(updatedAt)):'資料已同步')+'<span class="sync-check"> · 檢查 '+esc(clock.format(new Date()))+'</span>':'連線中斷 · 自動重試中';
    $('sync').classList.toggle('offline',!ok);
  }
  function setState(data) {
    revision=data.revision;records=data.records;updatedAt=data.updatedAt;loaded=true;
    if(data.timer){setTimer(data.timer);setTimeout(followField,0);}
    const names=teamNames();
    // 隊伍沒變時不重建選單，避免手機上正在開啟的下拉選單被關掉。
    if(names.join('\n')!==teamOptionsKey){
      teamOptionsKey=names.join('\n');
      const selectedTeam=$('team').value;
      $('team').innerHTML=opts(names,selectedTeam,'全部隊伍');
    }
    if(data.viewer){
      viewer=data.viewer;
      if(soundPref===null&&viewer.role==='referee'&&!sound){sound=true;soundPref='default';}
      if(tab==='devices'&&!viewer.canManage)tab='overview';
      $('who').innerHTML=viewer.remote?`<span>${esc(viewer.name)} · <b>${esc(roleLabels[viewer.role])}</b></span><form method="post" action="/logout"><button class="ghost" type="submit">登出</button></form>`:'<span>本機</span>';
    }
    markSynced();
  }
  async function load(silent) {
    const res=await fetch('/api/state'+(silent&&loaded?'?since='+revision+'&t='+timer.version:''),{cache:'no-store'});
    if(res.status===401){toLogin();return false;}
    if(res.status===204){markSynced();return false;}
    if(!res.ok)throw Error();
    setState(await res.json());
    return true;
  }
  async function refresh() {
    $('refresh').disabled=true;
    try { await load(false); } catch { markSynced(false); }
    finally {$('refresh').disabled=false;render();noteEditorChanges();}
  }
  // 每 0.5 秒自動同步（計時與即時計分）；資料與計時都沒變時伺服器回 204，不重繪畫面。
  async function poll() {
    if(document.hidden||saving||polling)return;
    polling=true;
    try { if(await load(true)){render();noteEditorChanges();} if(tab==='devices')loadDevices(); } catch { markSynced(false); }
    finally {polling=false;}
  }
  setInterval(poll,500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
  $('refresh').onclick=refresh;
  $('clear').onclick=()=>{Object.keys(filters).forEach(id=>{$(id).value='';});render();};
  const btn = (data,label,style='minor')=>`<button type="button" class="${style}" ${data}>${esc(label)}</button>`;
  const editBtn = (r,mode='',label='編輯')=>canEdit()?btn(`data-edit="${esc(r.id)}" data-mode="${mode}"`,label):'';
  const addBtn = type=>canEdit()?btn(`data-add="${type}"`,'＋ 新增'+titles[type],'primary'):'';
  const head = (title,detail='',extra='')=>`<header class="section-head"><div><h2>${title}</h2>${detail?`<p>${detail}</p>`:''}</div>${extra}</header>`;
  const empty = msg=>`<div class="panel empty">${msg}</div>`;
  const notice = (message,warn=false)=>`<p class="notice${warn?' warn':''}">${message}</p>`;
  const grid = items=>items.length?`<div class="cards">${items.join('')}</div>`:empty('此篩選條件下沒有紀錄。');
  const table = (headers,rows)=>rows.length?`<div class="panel scroll"><table><thead><tr>${headers.map(s=>'<th scope="col">'+s+'</th>').join('')}</tr></thead><tbody>${rows.map(cells=>'<tr>'+cells.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')}</tbody></table></div>`:empty('此篩選條件下沒有紀錄。');
  const find = id=>records.find(r=>r.id===id);
  const teamNames = ()=>[...new Set(records.filter(r=>r.type==='team').map(r=>r.team))];
  const scoreState = r=>rules.scoreState(records,r);
  const sides = r=>rules.sides(records,r);
  const matchFor = r=>r.type==='task'&&r.id.startsWith('W') ? find(r.id.slice(1)) : (r.match?r:find(r.matchRef));
  function visible(r, result=false) {
    const team=$('team').value;
    const period=$('period').value;
    const category=$('category').value;
    const status=$('status').value;
    const match=matchFor(r);
    const related=[r.team,r.teamB,...sides(match)].filter(Boolean);
    const includeShared=r.type==='schedule'&&!match&&related.length===0;
    const unresolved=match?.match==='knockout'&&sides(match).some(t=>!t);
    const possible=unresolved && (match.id==='K1' ? ['4','5'] : match.id==='K2' ? ['1','4','5'] : match.id==='K3' ? ['2','3'] : ['1','2','3','4','5']).includes(records.find(x=>x.match==='ranking'&&x.team===team&&x.resultStatus==='已確認')?.rank||'') ||
      unresolved&&!records.some(x=>x.match==='ranking'&&x.team===team&&x.resultStatus==='已確認'&&x.rank);
    return (!team||related.includes(team)||includeShared||possible) &&
      (!period||period===r.period||r.type==='team') &&
      (!category||category===r.category||(r.match&&['裁判','計時','檢錄','安全'].includes(category))) &&
      (!status||status===(result?scoreState(r):r.status));
  }
  const compare = (a,b)=>periods.indexOf(a.period)-periods.indexOf(b.period)||String(a.time||'').localeCompare(String(b.time||''));
  const list = (type,result=false)=>records.filter(r=>r.type===type&&visible(r,result)).sort(compare);
  const displaySides = r=>{
    const names=sides(r);
    if(rules.removed(r))return '已移除'+(r.team?' · '+esc(r.team):'');
    if(r.match==='knockout'&&rules.skipped(records,r))return '四隊賽制，不舉行';
    if(r.match==='knockout')return ['A','B'].map((side,i)=>names[i]?esc(names[i]):esc(rules.slotLabel(records,r,side)||'席位')+'（待確認）').join(' vs. ');
    return [r.team,r.teamB].filter(Boolean).map(esc).join('、')||'共用';
  };
  const scheduleRows = rows=>table(['時段／原訂時間','流程與工作','隊伍／對戰','負責','狀態','操作'],rows.map(r=>[
    `<span class="time">${val(r.time)}</span><small class="table-note">${val(r.period)}${r.actual?' · 實際 '+esc(r.actual):''}</small>`,
    `<strong>${esc(r.title)}</strong><small class="table-note">${esc(r.category)} · ${esc(r.notes)}${r.checkIn?' · 檢錄 '+esc(r.checkIn):''}</small>`,
    displaySides(r),val(r.owner),pill(r.status),`<div class="inline-buttons">${editBtn(r)}${r.match?editBtn(r,'score','計分'):''}</div>`
  ]));
  function baseCard(r,extra='',buttons='') {
    return `<article class="card"><header><small class="time">${esc([r.time,r.period,r.kind].filter(Boolean).join(' · '))}</small>${pill(r.status)}</header><h3>${esc(r.title)}</h3>${extra}<p>${esc(r.notes||'')}</p><div class="card-actions"><span class="caption">${esc([r.category,r.owner,r.team].filter(Boolean).join(' · '))}</span><div class="inline-buttons">${buttons}${editBtn(r)}</div></div></article>`;
  }
  const dl = entries=>'<dl>'+entries.map(([key,value])=>`<dt>${key}</dt><dd>${val(value)}</dd>`).join('')+'</dl>';
  function overview() {
    const venue=find('B0');
    const next=list('schedule').filter(r=>!terminal.includes(r.status)&&r.status!=='取消').slice(0,6);
    return (venue?notice(`<strong>活動場地 · ${esc(venue.status)}</strong>　${esc(venue.actual||venue.notes)}`,venue.status===pending):'')+
      head('場務速覽','依原訂時段排列。可切換至完整時程，或篩選指定隊伍。',btn('data-tab="schedule"','完整時程 →'))+scheduleRows(next)+
      head('固定競賽節點','每場依企劃書採 '+esc(event.rules)+'。')+
      `<div class="cards"><div class="card"><h3>上半場 · ${teams.length===5?'五':'四'}隊排名賽</h3><p>單隊投球，每隊 27 顆。上場順序由主審在「比賽計時」指定；全部確認後自動帶入名次。</p></div><div class="card"><h3>下半場 · ${teams.length===5?'四':'三'}場淘汰賽</h3><p>雙隊對抗，每隊 18 顆。兩隊由主審指定（預設依名次配對）；延誤時保留正式 3 分鐘與 5 分鐘維修。</p></div></div>`;
  }
  function scheduleView() {
    return head($('team').value?esc($('team').value)+' 賽程':'完整活動時程','原訂及實際時間分欄。下半場依已確認排名及勝者帶入隊伍。',addBtn('schedule'))+
      `<div class="team-links">${teamNames().map(t=>btn(`data-team="${esc(t)}"`,t)).join('')}${btn('data-team=""','全部隊伍')}</div>`+
      notice('上午採自由參與與單一場地輪替。每場上場前簡化檢錄。未定淘汰賽席位顯示可能場次。')+scheduleRows(list('schedule'));
  }
  function teamView() {
    return head('隊伍與檢錄','記錄隊伍、機器人、聯絡窗口及到場／檢錄資訊。',addBtn('team'))+
      notice('上午自由參加，無強制提前報到。主裁於每場開始前確認設備與安全。')+
      grid(list('team').map(r=>baseCard(r,dl([['學校',r.school],['機器人',r.robot],['操作員',r.operator],['聯絡人',r.contact],['聯絡方式',r.contactInfo],['到場時間',r.arrival],['檢錄紀錄',r.checkIn]]),btn(`data-team="${esc(r.team)}" data-tab="schedule"`,'查看賽程'))));
  }
  function board() {
    const rows=list('schedule');
    const lanes=[
      ['上午自由測試與場佈',r=>['活動前','上午'].includes(r.period)],
      ['下午正式賽與賽後',r=>!['活動前','上午'].includes(r.period)]
    ];
    return head('流程看板','點選卡片的編輯按鈕，可更新負責人、流程狀態及實際時間。')+
      `<div class="board">${lanes.map(([title,test])=>`<section class="lane"><h3>${title}</h3>${rows.filter(test).map(r=>baseCard(r,r.match?`<small>${displaySides(r)}</small>`:'',r.match?editBtn(r,'score','計分'):'')).join('')||empty('無符合條件的流程。')}</section>`).join('')}</div>`;
  }
  function staff() {
    return head('工作人員分工','企劃書配置六名固定工作人員。參賽隊伍共同協助回收與場地復原。',addBtn('staff'))+
      grid(list('staff').map(r=>baseCard(r,dl([['人員姓名',r.owner],['聯絡方式',r.contactInfo]]))))+
      head('集合、任務與交接清單','交接可登記接手人與實際完成時間。',addBtn('task'))+
      table(['時段／時間','任務及交接事項','負責／接手','狀態','操作'],list('task').map(r=>[
        `<span class="time">${val(r.time)}</span><small class="table-note">${val(r.period)}</small>`,
        `<strong>${esc(r.title)}</strong><small class="table-note">${esc(r.category)} · ${esc(r.notes)}</small>`,
        val(r.owner)+`<small class="table-note">接手 ${val(r.handoff)}${r.actual?' · '+esc(r.actual):''}</small>`,pill(r.status),editBtn(r)
      ]));
  }
  const safeLink = url=>esc(rules.safeLink(url));
  function resultSection(title,rows,played,byPlay,scoreRows) {
    const done=rows.filter(played).sort(byPlay), wait=rows.filter(r=>!played(r));
    return head(title,done.length?'依實際上場順序':'還沒有比過的場次')+(done.length?scoreRows(done):'')+
      (wait.length?`<details class="unplayed"${done.length?'':' open'}><summary>尚未上場（${wait.length}）：${wait.map(r=>esc(r.match==='ranking'?r.team:r.title)).join('、')}</summary>${scoreRows(wait)}</details>`:'');
  }
  function resultView() {
    const all=list('schedule',true).filter(r=>r.match);
    const results=all.filter(r=>!rules.removed(r)), gone=all.filter(r=>rules.removed(r));
    // 依實際上場順序列出比過的場次（排名賽順序不固定）；還沒上場的收在下面。
    const played=r=>Boolean(r.actual||r.cardA||r.cardB||['進行中','已完成'].includes(r.status)||['進行中','已確認'].includes(r.resultStatus));
    const byPlay=(a,b)=>String(a.actual||'99:99').localeCompare(String(b.actual||'99:99'))||String(a.editedAt||'').localeCompare(String(b.editedAt||''));
    const scoreRows = rows=>table(['場次／上場','隊伍／對戰','得分','名次／勝者','複核／簽認','操作'],rows.map(r=>[
      `<strong>${esc(r.title)}</strong><small class="table-note">${r.actual?'實際上場 '+esc(r.actual):played(r)?'已上場':'尚未上場'}</small>`,displaySides(r),
      `<span class="score">${val(r.scoreA)}${r.match==='knockout'?' ： '+val(r.scoreB):''}</span>`,
      val(r.match==='ranking'?r.rank:r.winner),pill(scoreState(r))+`<small class="table-note">${r.resultStatus==='已確認'&&scoreState(r)!=='已確認'?'隊伍有異動，原紀錄 '+esc(r.scoredTeamA)+' vs. '+esc(r.scoredTeamB)+'，請重新複核。 ':''}${r.signoff?'簽認 '+esc(r.signoff):'簽認待確認'}${r.scoreNotes?' · '+esc(r.scoreNotes):''}</small>`,rules.removed(r)?(canConfirm()?btn(`data-restore="${esc(r.id)}"`,'復原場次'):''):editBtn(r,'score','登錄計分')+(canConfirm()?btn(`data-remove="${esc(r.id)}"`,'移除場次','minor danger'):'')
    ]));
    const section=(title,rows)=>resultSection(title,rows,played,byPlay,scoreRows);
    return head('比賽成績與計分','逐場登錄，主裁確認後才帶入排名與淘汰賽勝者。','<a class="primary" href="/api/export.csv" download>下載成績 CSV</a>')+
      notice('計分依 09/03 版規則。上半場同分依序比較指定格命中、不同網框、實際入網、得分區球數、黃牌、剩餘救援卡、耗時。下半場在不同網框後比較實際連線數，並省略耗時。仍同分由總裁判抽籤。')+rankingSuggestion()+
      section('上半場 · 排名紀錄',results.filter(r=>r.match==='ranking'))+
      section('下半場 · 淘汰賽紀錄',results.filter(r=>r.match==='knockout'))+
      (gone.length?`<details class="unplayed"><summary>已移除的場次（${gone.length}）：${gone.map(r=>esc(r.match==='ranking'?r.team:r.title)).join('、')}</summary>${scoreRows(gone)}</details>`:'')+
      head('照片／影片索引','可登記連結、場次、拍攝者與備註。',addBtn('media'))+
      grid(list('media').map(r=>{
        const url=safeLink(r.url);
        return baseCard(r,dl([['媒體類型',r.mediaType],['場次',find(r.matchRef)?.title]])+(url?`<a href="${url}" target="_blank" rel="noopener noreferrer">開啟影像 ↗</a>`:'<small class="caption">影像連結待確認</small>'));
      }));
  }
  function incidents() {
    return head('臨時異動、延誤與備案','預載企劃書應變措施。可新增事件，記錄影響、通知、復原與結案。',addBtn('incident'))+
      grid(list('incident').map(r=>baseCard(r,dl([['發生時間',r.time],['處置／場地決議',r.actual],['影響與延誤',r.impact],['通知／交接',r.handoff]]))));
  }
  async function loadDevices() {
    if(!viewer.canManage)return;
    try {
      const res=await fetch('/api/sessions',{cache:'no-store'});
      if(res.status===401)return toLogin();
      if(!res.ok)throw Error();
      devices=await res.json();
    } catch { devices={error:'無法讀取人員與登入裝置。'}; }
    // 資料沒變就不重繪，避免正在輸入的姓名被清掉。
    const key=JSON.stringify(devices);
    if(tab==='devices'&&key!==devicesKey){devicesKey=key;render();}
  }
  function devicesView() {
    const when=iso=>iso?range.format(new Date(iso)):'';
    if(!devices)return head('人員與登入')+empty('讀取中…');
    if(devices.error)return head('人員與登入')+empty(esc(devices.error));
    const loggedIn=id=>devices.sessions.filter(s=>s.personId===id).length;
    const code=p=>revealed.has(p.id)?`<span class="code inline">${esc(p.code)}</span>`:'••••••••';
    const people=devices.people.slice().sort((a,b)=>Number(b.active)-Number(a.active));
    return head('人員與登入','每位工作人員一組個人通行碼，登入後姓名與權限自動帶入。停用或重新產生後，該人的手機立即登出。',btn('data-devices-refresh','重新整理'))+
      `<div class="cards"><div class="card"><small class="caption">檢視通行碼（共用）</small><h3 class="code">${esc(devices.viewCode)}</h3><p>給觀摩新生、各隊聯絡人。只能查看，登入時自己填姓名。</p></div>
      <div class="card add-person"><small class="caption">新增工作人員</small>
        <label>姓名／職務<input id="person-name" maxlength="30" value="${esc(personDraft.name)}" placeholder="例如：王小明（計分 A）"></label>
        <label>權限<select id="person-role"><option value="edit"${personDraft.role==='edit'?' selected':''}>計分：修改賽程、檢錄、登錄計分</option><option value="referee"${personDraft.role==='referee'?' selected':''}>主裁判／總召：最高權限（確認成績、管理名單）</option><option value="camera"${personDraft.role==='camera'?' selected':''}>攝影：登入後滿版顯示直播字卡（只能看）</option></select></label>
        ${btn('data-person-create','新增並產生通行碼','primary')}</div></div>`+
      notice('通行碼請當面或私訊交給本人，不要貼到群組。外流時按「重新產生」，舊的通行碼立即失效。')+
      head('人員名單')+
      table(['姓名','權限','個人通行碼','狀態','操作'],people.map(p=>[
        `<strong>${esc(p.name)}</strong><small class="table-note">由 ${esc(p.createdBy)} 建立 · ${esc(when(p.createdAt))}</small>`,
        esc(p.roleLabel),
        code(p)+' '+btn(`data-person-reveal="${esc(p.id)}"`,revealed.has(p.id)?'隱藏':'顯示'),
        p.active?`啟用中<small class="table-note">${loggedIn(p.id)} 個裝置登入中</small>`:'<span class="muted">已停用</span>',
        `<div class="inline-buttons">${p.active?btn(`data-person-action="disable" data-person-id="${esc(p.id)}" data-person-name="${esc(p.name)}"`,'停用')+btn(`data-person-action="regenerate" data-person-id="${esc(p.id)}" data-person-name="${esc(p.name)}"`,'重新產生'):btn(`data-person-action="enable" data-person-id="${esc(p.id)}" data-person-name="${esc(p.name)}"`,'重新啟用')}</div>`
      ])).replace('此篩選條件下沒有紀錄。','還沒有建立任何人。請在上方新增工作人員。')+
      head('登入中的裝置')+
      table(['姓名','權限','裝置／IP','登入時間','最後活動','操作'],devices.sessions.map(s=>[
        `<strong>${esc(s.name)}</strong>${s.id===devices.current?'<small class="table-note">（目前這支）</small>':''}`,
        esc(s.roleLabel),`${esc(s.agent)}<small class="table-note">${esc(s.ip)}</small>`,esc(when(s.createdAt)),esc(when(s.lastSeen)),
        btn(`data-revoke="${esc(s.id)}" data-revoke-name="${esc(s.name)}"`,'撤銷')
      ])).replace('此篩選條件下沒有紀錄。','目前沒有手機登入。');
  }
  async function manage(path,body,done) {
    try {
      const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await res.json();
      if(res.status===401)return toLogin();
      if(!res.ok)return toast(data.error||'操作失敗');
      devices=data;devicesKey=JSON.stringify(data);
      if(!data.sessions.some(s=>s.id===data.current)&&viewer.remote)return toLogin();
      done(data);render();
    } catch { toast('連線失敗，請重試'); }
  }
  function revokeDevice(id,name) {
    if(!confirm('確定要讓「'+name+'」這個裝置登出？他可以用通行碼重新登入；要完全擋掉請停用他的通行碼。'))return;
    manage('/api/sessions/revoke',{id},()=>toast('已撤銷「'+name+'」'));
  }
  function createPerson() {
    personDraft.name=$('person-name').value.trim();personDraft.role=$('person-role').value;
    if(!personDraft.name)return toast('請先填寫姓名');
    manage('/api/people',{action:'create',name:personDraft.name,role:personDraft.role},data=>{
      revealed.add(data.changed.id);toast('已建立「'+personDraft.name+'」，通行碼 '+data.changed.code);personDraft.name='';
    });
  }
  function personAction(action,id,name) {
    const ask={disable:'停用「'+name+'」？他的手機會立即登出，通行碼失效。',regenerate:'重新產生「'+name+'」的通行碼？舊的立即失效，他要用新的重新登入。',enable:''}[action];
    if(ask&&!confirm(ask))return;
    manage('/api/people',{action,id},data=>{
      if(action==='regenerate'){revealed.add(id);toast('「'+name+'」的新通行碼：'+data.changed.code);}
      else toast(action==='disable'?'已停用「'+name+'」':'已重新啟用「'+name+'」');
    });
  }
  function render() {
    const selected = Object.keys(filters).map(id=>$(id).value).filter(Boolean);
    $('active-filters').textContent = selected.length?'篩選：'+selected.join('・'):'未套用篩選';
    $('nav').innerHTML=Object.entries(links).filter(([id])=>id!=='devices'||viewer.canManage).map(([id,[name,icon]])=>`<button type="button" data-tab="${id}" ${id===tab?'aria-current="page"':''}><span aria-hidden="true">${icon}</span>${name}</button>`).join('');
    $('crumb').textContent=links[tab][0];
    const teamRows=records.filter(r=>r.type==='team');
    const matches=records.filter(r=>r.match&&!rules.removed(r));
    const taskRows=records.filter(r=>r.type==='task');
    const venue=find('B0');
    const stats=[
      ['teams','參賽隊伍',teamRows.length+' 隊',teamRows.filter(r=>['已到場','已檢錄'].includes(r.status)).length+' 隊已到場／檢錄'],
      ['results','正式場次',matches.length+' 場',matches.filter(r=>scoreState(r)==='已確認').length+' 場成績已確認'],
      ['staff','賽務任務',taskRows.filter(r=>terminal.includes(r.status)).length+' / '+taskRows.length,'集合、交接、場地復原'],
      ['incidents','比賽場地',venue?.status||pending,venue?.actual||event.venueFallback]
    ];
    $('stats').innerHTML=loaded?stats.map(([id,label,value,subtitle])=>`<button class="stat" data-tab="${id}"><small>${label}</small><strong>${esc(value)}</strong><span>${esc(subtitle)}</span></button>`).join(''):'';
    $('view').innerHTML=loaded?(viewer.role==='view'?notice('你使用檢視通行碼登入，只能查看。需要修改時，請向總召索取計分通行碼。'):'')+
      ({overview,timer:timerTab,schedule:scheduleView,teams:teamView,board,staff,results:resultView,incidents,devices:devicesView})[tab]():empty('賽務資料載入後會顯示在此處。');
    paintTimer();
  }
  // ── 比賽計時 ──
  // 伺服器回傳「已經過幾毫秒」；這裡用 performance.now() 往下數，手機時鐘不準也沒關係。
  let timer={version:0,mode:'idle'}, timerAt=0, timerPick='', sound=false, audio=null, lastCue={key:'',elapsed:0};
  // 主審／總召預設開啟比賽音效（沒設定過時）；其他人預設關閉，可在計時頁勾選。
  let soundPref=null;
  try{soundPref=localStorage.getItem('tel-timer-sound');}catch{}
  sound=soundPref==='1';
  // 比賽音效（與觀賽畫面、直播字卡相同）：開始、第 60 秒手動、剩 30 秒、結束。
  const frcCue=clockRules.cueTracker();
  const frcAudio=Object.fromEntries(['start','resume','warning','end'].map(name=>[name,new Audio('/sounds/'+name+'.mp3')]));
  // 瀏覽器要先有一次點擊才能出聲：開啟音效後，第一次點畫面時解鎖。
  function unlockSound() {
    try{audio=audio||new AudioContext();audio.resume();}catch{}
    for(const a of Object.values(frcAudio)){a.muted=true;a.play().then(()=>{a.pause();a.currentTime=0;a.muted=false;},()=>{a.muted=false;});}
  }
  let soundUnlocked=false;
  document.addEventListener('pointerdown',()=>{if(sound&&!soundUnlocked){soundUnlocked=true;unlockSound();}});
  function setTimer(t) {timer=t;timerAt=performance.now();}
  const timerRunning=()=>timer.running&&timerElapsed()<timer.duration*1000;
  function timerElapsed() {
    if(timer.mode==='idle')return 0;
    return Math.min(timer.duration*1000,timer.elapsedMs+(timer.running?performance.now()-timerAt:0));
  }
  function stallLeft() {
    if(timer.stallMs==null)return null;
    return Math.max(0,clockRules.STALL-(timer.stallMs+(timer.stallRunning?performance.now()-timerAt:0)));
  }
  function setSound(on) {
    sound=on;
    try{localStorage.setItem('tel-timer-sound',on?'1':'0');}catch{}
    if(on){soundUnlocked=true;unlockSound();setTimeout(()=>{const a=frcAudio.start;a.currentTime=0;a.play().catch(()=>{});},150);}
  }
  function beep(times=1,long=false) {
    navigator.vibrate?.(long?[400]:Array.from({length:times*2-1},(_,i)=>i%2?120:150));
    if(!sound||!audio)return;
    for(let i=0;i<times;i++){
      const osc=audio.createOscillator(),gain=audio.createGain(),at=audio.currentTime+i*0.28;
      osc.frequency.value=long?660:880;gain.gain.setValueAtTime(0.25,at);gain.gain.exponentialRampToValueAtTime(0.001,at+(long?0.9:0.2));
      osc.connect(gain).connect(audio.destination);osc.start(at);osc.stop(at+(long?0.9:0.2));
    }
  }
  // 跨過關鍵時間點時提醒一次：比賽音效（開始、第 60 秒手動、剩 30 秒、結束）＋手機震動；機器人靜止倒數到時嗶三聲。
  function cues(elapsed,stall) {
    const played=frcCue(timer,elapsed);
    if(played){
      navigator.vibrate?.(played==='end'?[400]:[150]);
      if(sound){const a=frcAudio[played];a.currentTime=0;a.play().catch(()=>{});}
    }
    if(timer.mode==='idle')return;
    const key=timer.version+timer.mode;
    if(lastCue.key!==key){lastCue={key,elapsed,stall};return;}
    if(lastCue.stall>0&&stall===0)beep(3);
    lastCue.elapsed=elapsed;lastCue.stall=stall;
  }
  function paintTimer() {
    const elapsed=timerElapsed(), stall=stallLeft();
    const d=clockRules.describe(timer,elapsed,stall);
    cues(elapsed,stall);
    document.body.classList.toggle('timing',Boolean(d));
    const bar=$('timer-bar');
    bar.hidden=!d||tab==='timer';
    if(d){
      bar.dataset.tone=d.tone;
      $('tb-label').textContent=d.label+(d.match?' · '+d.match:'');
      $('tb-clock').textContent=d.clock;
      $('tb-sub').textContent=d.stall||d.sub;
    }
    if($('tv-clock')){
      $('tv-face').dataset.tone=d?.tone||'idle';
      $('tv-label').textContent=d?d.label+(d.match?' · '+d.match:''):'目前沒有計時';
      $('tv-clock').textContent=d?d.clock:'—:—';
      $('tv-sub').textContent=d?d.sub:(canConfirm()?'選擇場次後按「① 調整準備」或「② 開始比賽」。':'主裁判或總召開始計時後，這裡會同步顯示。');
      $('tv-stall').textContent=d?.stall||'';
      $('tv-by').textContent=timer.by?'最後操作：'+timer.by+(timer.at?' · '+clock.format(new Date(timer.at)):''):'';
      const pick=$('timer-match')?.value||'';
      const record=find(pick);
      const on=(name,enabled)=>{const b=document.querySelector(`[data-timer="${name}"]`);if(b)b.disabled=!enabled;};
      const running=timerRunning(), paused=Boolean(d)&&!timer.running&&!d.over&&!timer.finished;
      on('field',Boolean(record));on('prep',Boolean(record));on('match',Boolean(record));
      const now=find(timer.field);
      if($('field-now'))$('field-now').textContent=now?'目前在場上：'+(now.match==='knockout'?now.title+'（'+sides(now).filter(Boolean).join(' vs. ')+'）':'排名賽 · '+(now.team||'')):'目前在場上：尚未指定';on('repair',record?.match==='knockout');
      on('pause',running);on('resume',paused);
      document.querySelector('[data-timer="pause"]')?.toggleAttribute('hidden',paused);
      document.querySelector('[data-timer="resume"]')?.toggleAttribute('hidden',!paused);
      on('finish',timer.mode==='match'&&!timer.finished);
      on('stall',timer.mode==='match'&&running&&stall===null);
      on('stallClear',stall!==null&&timer.mode==='match'&&!timer.finished&&!d?.over);
      on('reset',Boolean(d));
    }
    // 計分視窗：同一場正在計時時顯示，裁判判斷「前 60 秒亮燈」用；排名賽按完成後可以一鍵帶入用時。
    const line=$('editor-timer');
    if(line&&$('editor').open&&edited){
      const same=d&&timer.mode==='match'&&timer.matchId===edited.id;
      line.hidden=!same;
      if(same){line.dataset.tone=d.tone;line.textContent='⏱ '+d.clock+' · '+(d.stall||d.sub);}
      const fill=$('fill-seconds');
      if(fill){
        const ready=same&&(timer.finished||d.over);
        fill.hidden=!ready||tapLocked;
        if(ready){fill.dataset.seconds=String(d.used);fill.textContent='帶入計時 '+d.used+' 秒';}
      }
    }
  }
  setInterval(paintTimer,250);
  function timerTab() {
    const matches=records.filter(r=>r.match&&!rules.removed(r));
    const fallback=timer.field||timer.matchId||matches.find(r=>scoreState(r)!=='已確認')?.id||matches[0]?.id||'';
    const pick=find(timerPick)?timerPick:fallback;
    const button=(action,label,style='')=>`<button type="button" class="${style||'ghost'}" data-timer="${action}">${esc(label)}</button>`;
    const controls=canConfirm()?`<div class="timer-controls">
        <p class="field-now" id="field-now"></p>
        <label>上場（排名賽選隊伍，順序不限；淘汰賽選場次）<select id="timer-match">${fieldOptions(matches,pick)}</select></label>
        <div id="timer-teams">${fieldTeamsHtml(find(pick))}</div>
        <div class="timer-buttons">
          ${button('field','📣 指定上場（計分員自動切換）','primary field-btn')}
          ${button('prep','① 調整準備 90 秒','primary')}${button('match','② 開始比賽 3 分鐘','primary')}
          ${button('pause','⏸ 暫停')}${button('resume','▶ 繼續')}
          ${button('finish','✓ 完成（記錄用時）')}${button('stall','機器人靜止：倒數 30 秒')}
          ${button('stallClear','取消靜止倒數')}${button('repair','晉級隊維修 5 分鐘')}
          ${button('reset','重設計時')}
        </div>
        <p class="caption">暫停只用於緊急停止等裁判判定；規則上準備未完成時比賽時間不暫停。每次操作都會記在該場次的修改歷史。</p>
      </div>`:notice('計時由主裁判或總召操作，這裡與觀賽畫面同步顯示。');
    return head('比賽計時','依 2026/9/3 規則：調整準備 90 秒 → 正式比賽 3 分鐘（前 60 秒 AI 自主控制、小洞亮燈）；下半場勝隊維修 5 分鐘。')+
      `<section class="panel panel-pad timer-panel"><div class="timer-face" id="tv-face" role="timer"><small id="tv-label"></small><strong id="tv-clock"></strong><span id="tv-sub"></span><b id="tv-stall"></b><small id="tv-by" class="caption"></small></div>
      ${controls}
      <label class="timer-sound"><input type="checkbox" id="timer-sound"${sound?' checked':''}> 這支手機播放比賽音效（開始、第 60 秒手動、剩 30 秒、結束；機器人靜止倒數到時嗶聲）</label></section>`;
  }
  // 上場選單：排名賽依現有隊伍列出（選隊伍＝選那一隊的排名賽），淘汰賽列場次。
  function fieldOptions(matches,pick) {
    const mark=r=>(r.id===timer.field?'▶ ':'')+(scoreState(r)==='已確認'?'✓ ':'');
    const option=(r,label)=>`<option value="${esc(r.id)}"${r.id===pick?' selected':''}>${esc(mark(r)+label)}</option>`;
    const ranking=teamNames().map(team=>matches.find(r=>r.match==='ranking'&&r.team===team)).filter(Boolean);
    const knockout=matches.filter(r=>r.match==='knockout');
    return `<optgroup label="排名賽（選隊伍）">${ranking.map(r=>option(r,r.team)).join('')}</optgroup>`+
      `<optgroup label="淘汰賽">${knockout.map(r=>{const names=sides(r).filter(Boolean);return option(r,r.title+(names.length?'（'+names.join(' vs. ')+'）':''));}).join('')}</optgroup>`;
  }
  // 淘汰賽：主審手動選兩隊；預設帶入依排名與勝者算出的配對。
  function fieldTeamsHtml(r) {
    if(!r||r.match!=='knockout')return '';
    const names=sides(r), list=teamNames();
    const select=(id,label,value)=>`<label>${label}<select id="${id}"><option value="">請選擇</option>${list.map(n=>`<option value="${esc(n)}"${n===value?' selected':''}>${esc(n)}</option>`).join('')}</select></label>`;
    return `<div class="timer-teams">${select('field-a','A 方隊伍（藍）',names[0])}${select('field-b','B 方隊伍（紅）',names[1])}</div><p class="caption">預設帶入依排名算出的配對，可以改。按「指定上場」後鎖定這兩隊。</p>`;
  }
  // 主審指定上場：計分員（計分權限）的計分視窗自動切到那一場；正在編輯別的資料時只提示，不強制跳走。
  let fieldSeen=null;
  function followField() {
    const id=timer.field||'';
    if(fieldSeen!==null&&id===fieldSeen)return;
    fieldSeen=id;
    if(!id||viewer.role!=='edit')return;
    const r=find(id);
    if(!r)return;
    const label=r.title+(r.match==='knockout'?'（'+sides(r).filter(Boolean).join(' vs. ')+'）':'');
    if($('editor').open){
      if(editMode==='score'&&edited?.id===id)return;
      if(editMode!=='score'||saving){toast('主審已指定「'+label+'」上場，這筆存好後請開計分');return;}
      close();
    }
    openEditor(r,'score');
    toast('主審指定上場：'+label);
  }
  async function timerAction(action) {
    const matchId=$('timer-match')?.value||timer.matchId||'';
    const busy=timerRunning()||(timer.mode!=='idle'&&!timer.finished&&timerElapsed()<timer.duration*1000);
    if(clockRules.modes[action]&&busy&&!confirm('目前的計時還沒結束，要直接改成「'+clockRules.modes[action][0]+'」嗎？'))return;
    if(action==='reset'&&busy&&!confirm('計時還沒結束，確定要重設？'))return;
    document.querySelectorAll('[data-timer]').forEach(b=>{b.disabled=true;});
    try{
      if(action==='field'){
        const r=find(matchId);
        if(r?.match==='knockout'){
          const a=$('field-a')?.value||'', b=$('field-b')?.value||'';
          if(!a||!b||a===b){toast('請選好這場的兩隊（不能是同一隊）');return;}
          if((r.team||'')!==a||(r.teamB||'')!==b){
            const saved=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:r.id,type:r.type,changes:{team:a,teamB:b},base:{team:r.team||'',teamB:r.teamB||''}})});
            if(saved.status===401)return toLogin();
            const data=await saved.json();
            if(!saved.ok){if(data.state)setState(data.state);toast(data.error||'對戰隊伍沒有存成功，請再按一次');return;}
            setState(data);
          }
        }
      }
      const res=await fetch('/api/timer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,matchId})});
      if(res.status===401)return toLogin();
      const data=await res.json();
      if(data.timer)setTimer(data.timer);
      if(!res.ok)toast(data.error||'計時操作失敗');
      else toast(clockRules.actions[action]);
      if(clockRules.modes[action])timerPick=matchId;
    }catch{toast('連線失敗，計時沒有改變，請再按一次。');}
    finally{if(tab==='timer')render();paintTimer();}
  }
  // ── 即時計分：點擊後 0.4 秒內沒有再點就自動送出計分明細（只送明細與亮燈小洞，簽認與確認仍要按儲存）──
  let draftTimer=null, drafting=false, draftAgain=false;
  const draftKeys=['cardA','cardB','target'];
  // 和別人衝突的欄位不再自動送出，等使用者核對後按「儲存紀錄」才覆蓋（避免默默蓋掉別人的內容）。
  const draftHold=new Set();
  let holdBy='';
  // 送出過的值：回應在路上斷掉、其實已寫入時，下一次同步看到的「衝突」就是自己，不是別人。
  let draftSent={};
  // 紀錄只存最後修改者；如果是自己（例如自己剛同步了另一方），就不要寫成自己的名字。
  const otherName=name=>name&&name!==viewer.name?name:'其他人';
  function scheduleDraft() {
    if(tapLocked||!original||!edited?.match)return;
    clearTimeout(draftTimer);
    draftTimer=setTimeout(()=>{draftTimer=null;saveDraft();},400);
  }
  function draftNote(message,warn=false) {const note=$('draft-state');if(note){note.textContent=message;note.classList.toggle('warn',warn);}}
  const holeLabel=v=>({'1':'左','2':'中','3':'右'})[v]||'未選';
  function holdNote(current) {
    const who=holdBy||otherName(current?.editedBy);
    const parts=[...draftHold].map(key=>key==='target'?'亮燈小洞（對方選「'+holeLabel(current?.target)+'」，你選「'+holeLabel($('form').elements.target?.value)+'」）':labelOf(key));
    draftNote('⚠ '+who+' 改了不同的'+parts.join('、')+'，這部分沒有同步，其他照常同步。請和對方核對：你的才對就按「儲存紀錄」覆蓋，對方的才對請把這裡改成一樣。',true);
  }
  // 別人即時同步的計分明細與亮燈小洞：自己沒動過的部分直接帶入（兩位計分員、主裁判看到同一份）。
  function adoptShared() {
    if(!original||!$('editor').open||saving||editMode!=='score'||!$('score-A'))return;
    const latest=find(original.id);
    if(!latest)return;
    const form=$('form');
    const norm=v=>v?JSON.stringify(scoring.read(v)):'';
    let changed=false;
    const target=form.elements.target;
    if(target&&(latest.target??'')!==(original.target??'')&&target.value===(original.target??'')){
      target.value=latest.target??'';original.target=edited.target=latest.target??'';
      draftHold.delete('target');changed=true;
    }
    if(target&&draftHold.has('target')&&target.value===(latest.target??'')){draftHold.delete('target');original.target=edited.target=latest.target??'';}
    for(const side of edited.match==='knockout'?['A','B']:['A']){
      const key='card'+side;
      if(!form.elements['input'+side+'0']||norm(latest[key])===norm(original[key]))continue;
      const record={...edited};formScores(new FormData(form),record);
      if(norm(record[key])!==norm(original[key]))continue; // 自己改過這一方：保留自己的，存檔時照常檢查衝突。
      const card=scoring.read(latest[key]);
      const put=(k,v)=>{const el=form.elements['input'+side+k];if(el)el.value=v;};
      for(let i=0;i<9;i++)put(i,card?String(card.grid[i]):'');
      for(const k of ['lit','hole','miss','yellow'])put(k,card?String(card[k]??0):'');
      put('rescue',card?String(card.rescue):'3');put('seconds',card?String(card.seconds):'180');put('outcome',card?.outcome||'normal');
      for(const k of [key,'score'+side,'scoredTeamA','scoredTeamB']){original[k]=latest[k];edited[k]=latest[k];}
      undo[side]=[];draftHold.delete(key);changed=true;
    }
    if(changed){refreshScores();if(!draftHold.size&&$('draft-state')?.classList.contains('warn'))draftNote('已帶入其他人的最新明細 · '+clock.format(new Date()));}
  }
  async function saveDraft() {
    if(!$('editor').open||saving||tapLocked||!original||!$('score-A'))return;
    if(drafting){draftAgain=true;return;}
    const form=new FormData($('form'));
    const record={...edited,target:form.get('target')||''};
    const [a,b]=formScores(form,record);
    if(a?.error||b?.error)return draftNote(a?.error||b?.error,true);
    const keys=draftKeys.filter(key=>!draftHold.has(key)&&(record[key]??'')!==(original[key]??''));
    if(!keys.length)return;
    const id=original.id;
    drafting=true;if(!draftHold.size)draftNote('同步中…');
    try{
      const changes=Object.fromEntries(keys.map(key=>[key,String(record[key]??'')]));
      for(const key of keys)(draftSent[key]||=new Set()).add(changes[key]);
      const res=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type:original.type,
        changes,base:Object.fromEntries(keys.map(key=>[key,String(original[key]??'')]))})});
      if(res.status===401)return toLogin();
      const data=await res.json();
      if(!res.ok){
        if(data.state)setState(data.state);
        if(res.status===409&&data.conflicts){
          // 衝突的明細是自己先前送出的（當時沒收到回應）：當作已送達，以它為基準再送一次。亮燈小洞只有三種值，可能剛好和別人一樣，不套用。
          const mine=data.conflicts.filter(key=>key.startsWith('card')&&draftSent[key]?.has(data.current?.[key]??''));
          for(const key of mine){original[key]=data.current[key];edited[key]=data.current[key];}
          data.conflicts=data.conflicts.filter(key=>!mine.includes(key));
          if(!data.conflicts.length){draftAgain=true;return draftNote('同步中…');}
          // 只擋下衝突的欄位，其他欄位（例如自己這一方的九宮格）馬上再送一次。
          data.conflicts.forEach(key=>draftHold.add(key));holdBy=otherName(data.current?.editedBy);
          if(keys.some(key=>!draftHold.has(key)))draftAgain=true;
          return holdNote(data.current);
        }
        return draftNote((data.error||'即時同步失敗')+'，按「儲存紀錄」時會再送一次。',true);
      }
      setState(data);
      const latest=find(id);
      // 只把這次送出的欄位與伺服器算出的欄位當成新的基準，別人改的其他欄位照常提示衝突。
      if(latest&&original?.id===id)for(const key of [...keys,'scoreA','scoreB','scoredTeamA','scoredTeamB','editedBy','editedAt']){original[key]=latest[key];edited[key]=latest[key];}
      render();noteEditorChanges();
      if(draftHold.size)holdNote(latest);
      else draftNote('已即時同步 · '+clock.format(new Date()));
    }catch{draftNote('連線中斷，按「儲存紀錄」時會再送一次。',true);}
    finally{drafting=false;if(draftAgain){draftAgain=false;saveDraft();}}
  }
  // 選項的值和顯示文字不同時用這個（opts 的值就是顯示文字）。
  const valueOptions=(items,value='',blank)=>`<option value="">${esc(blank)}</option>`+items.map(([v,label])=>`<option value="${esc(v)}"${v===value?' selected':''}>${esc(label)}</option>`).join('');
  const cellNames=['上左','上中','上右','中左','中央','中右','下左','下中','下右'];
  const undo={A:[],B:[]};
  let tapLocked=false;
  const holeNames=['左','中','右'];
  // 點擊九宮格／小洞／計數器。每次點擊記一筆復原紀錄（點小洞順便選定亮燈小洞，算同一步）。
  function tap(button) {
    if(tapLocked||!sideAllowed(button.dataset.tap))return;
    const side=button.dataset.tap, step=Number(button.dataset.step);
    let key=button.dataset.key;
    const form=$('form'), field=k=>form.elements['input'+side+k];
    const get=k=>Number(field(k)?.value||0);
    if(key==='undo'){
      const last=undo[side].pop();
      if(last)for(const [k,v] of last.reverse())(k==='target'?form.elements.target:field(k)).value=v;
      refreshScores();
      return;
    }
    const changes=[];
    // 小洞：亮燈的那一個記入「亮燈計分」，其他小洞記入「不計分」；尚未選亮燈小洞時，第一次點的小洞就是亮燈小洞。
    if(key==='hole-tap'){
      const target=form.elements.target;
      if(!target.value){changes.push(['target',target.value]);target.value=button.dataset.hole;}
      key=target.value===button.dataset.hole?'lit':'hole';
    }
    const limit=edited.match==='knockout'?18:27;
    const ball=/^[0-8]$/.test(key)||['miss','lit','hole'].includes(key);
    const balls=Array.from({length:9},(_,i)=>get(i)).reduce((a,b)=>a+b,0)+get('lit')+get('hole')+get('miss');
    if(step>0&&ball&&balls>=limit){
      for(const [,v] of changes)form.elements.target.value=v;
      toast('九宮格、小洞加未入網已達 '+limit+' 顆，不能再加');return;
    }
    const next=get(key)+step;
    if(next<0||next>({yellow:999,rescue:3}[key]??limit)){for(const [,v] of changes)form.elements.target.value=v;return;}
    changes.push([key,field(key).value]);
    field(key).value=String(next);
    undo[side].push(changes);
    navigator.vibrate?.(12);
    refreshScores();
  }
  function paintTaps() {
    const form=$('form');
    const knockout=edited.match==='knockout';
    const cap=knockout?2:3;
    const target=form.elements.target?.value||'';
    for(const side of ['A','B']){
      if(!form.elements['input'+side+'0'])continue;
      const get=k=>Number(form.elements['input'+side+k].value||0);
      for(let i=0;i<9;i++){
        const n=get(i);
        $('cnt-'+side+i).textContent=n;
        $('note-'+side+i).textContent=n>cap?'超出 '+(n-cap)+' 不計':n===cap?'已滿':'';
        $('cell-'+side+i).classList.toggle('capped',n>=cap);
      }
      const lit=get('lit');
      for(let h=1;h<=3;h++){
        const lamp=$('hole-'+side+h), on=String(h)===target;
        lamp.classList.toggle('lit',on);
        lamp.querySelector('span').textContent=on?'💡 亮燈 · 已計 '+Math.min(lit,cap)+'/'+cap+(lit>cap?'（超出 '+(lit-cap)+' 不計）':''):target?'未亮燈 · 不計分':'點這裡＝這個洞亮燈';
      }
      for(const k of ['lit','hole','miss','yellow','rescue'])$('cnt-'+side+k).textContent=get(k);
      form.querySelector(`.tap-undo[data-tap="${side}"]`).disabled=tapLocked||!undo[side].length;
    }
    // 淘汰賽：只能點自己負責的那一方；對方縮成只顯示總分，避免點錯邊。
    const pick=sidePick();
    for(const side of ['A','B']){
      const fs=$('fs-'+side);
      if(!fs)continue;
      const ok=!tapLocked&&sideAllowed(side);
      fs.classList.toggle('side-mine',knockout&&pick===side);
      fs.classList.toggle('side-other',knockout&&Boolean(pick)&&pick!=='both'&&pick!==side);
      form.querySelectorAll(`[data-tap="${side}"]`).forEach(b=>{b.disabled=!ok||(b.dataset.key==='undo'&&!undo[side].length);});
    }
    const pickBox=$('side-pick');
    if(pickBox){
      pickBox.querySelectorAll('[data-side-pick]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.sidePick===pick));b.disabled=tapLocked;});
      pickBox.classList.toggle('need',!pick&&!tapLocked);
      $('side-wait-note').hidden=Boolean(pick)||tapLocked;
    }
  }
  // 「我負責」的選擇記在這支手機（依登入姓名分開）；主裁判預設兩方，計分員要先選。
  let sideChoice=null;
  const sideKey=()=>'tel-score-side:'+(viewer.name||'');
  function sidePick() {
    if(edited?.match!=='knockout')return 'both';
    if(sideChoice===null){sideChoice='';try{sideChoice=localStorage.getItem(sideKey())||'';}catch{}}
    return ['A','B','both'].includes(sideChoice)?sideChoice:(canConfirm()?'both':'');
  }
  const sideAllowed=side=>{const pick=sidePick();return pick==='both'||pick===side;};
  function chooseSide(side) {
    sideChoice=side;
    try{localStorage.setItem(sideKey(),side);}catch{}
    refreshScores();
  }
  function scoreInputs(record) {
    const knockout=record.match==='knockout';
    const sidesInMatch=knockout?['A','B']:['A'];
    const names=sides(record);
    const number=(key,label,value,max)=>`<label>${label}<input name="${key}" type="number" min="0" max="${max}" step="1" inputmode="numeric" value="${esc(value)}" placeholder="0"></label>`;
    // 點擊式計分：每個欄位仍是 input（隱藏），按鈕只負責加減，總分由 refreshScores 試算、伺服器存檔時重新計算。
    undo.A=[];undo.B=[];
    const cap=knockout?2:3;
    const hidden=(name,value)=>`<input type="hidden" name="${name}" value="${esc(value)}">`;
    const tapButton=(side,key,step,label,text,extra='')=>`<button type="button" data-tap="${side}" data-key="${key}" data-step="${step}" aria-label="${esc(label)}" ${extra}>${text}</button>`;
    const cell=(side,i,card)=>`<div class="tap-cell" id="cell-${side}${i}">
        <button type="button" class="tap-main" data-tap="${side}" data-key="${i}" data-step="1" aria-label="${cellNames[i]} 入網 +1"><small>${cellNames[i]}</small><strong id="cnt-${side}${i}">0</strong><span id="note-${side}${i}"></span></button>
        ${tapButton(side,i,-1,cellNames[i]+' −1','−1','class="tap-minus"')}
        ${hidden('input'+side+i,card?.grid?.[i]??'')}</div>`;
    const holes=side=>`<div class="tap-holes" aria-label="上方三個小洞（TEL 加分網框）">${holeNames.map((name,i)=>
      `<button type="button" class="tap-hole" id="hole-${side}${i+1}" data-tap="${side}" data-key="hole-tap" data-hole="${i+1}" data-step="1" aria-label="小洞${name} 進球 +1"><small>TEL 小洞 ${name}</small><span></span></button>`).join('')}</div>`;
    const stepper=(side,key,label,value)=>`<div class="stepper"><span>${label}</span>${tapButton(side,key,-1,label+' −1','−')}<output id="cnt-${side}${key}">0</output>${tapButton(side,key,1,label+' +1','+')}${hidden('input'+side+key,value)}</div>`;
    return `<section class="score-editor full">
      <p class="editor-timer" id="editor-timer" role="timer" hidden></p>
      <p class="draft-state" id="draft-state" role="status"></p>
      <p class="notice">九宮格：球進哪一格就點哪一格（+1），每顆 2 分，每格最多計 ${cap} 顆；超過的也要點，系統只計上限${knockout?'。連線（斜 8、直 4、橫 2）只看九宮格，每條只算一次':''}。<br>上方三個小洞（TEL 加分網框）：開賽前 60 秒會亮一個。亮燈期間進亮燈小洞，每顆 4 分，最多 ${cap} 顆。進沒亮的小洞，或 60 秒後才進，都不計分，請改按「小洞不計分」的 +。<br>點錯按「−1」或「復原上一步」。黃牌每張扣 1 分，分數由系統計算。</p>
      <div class="score-options"><label>亮燈的小洞（前 60 秒）<select name="target">${valueOptions([['1','左'],['2','中'],['3','右']],record.target,'待確認')}</select></label>
</div>
      ${knockout?`<div class="side-pick" id="side-pick" role="group" aria-label="我負責哪一方"><span>我負責</span>${sidesInMatch.map((side,i)=>`<button type="button" data-side-pick="${side}">${side} 方 · ${esc(names[i]||'待確認')}</button>`).join('')}<button type="button" data-side-pick="both">兩方</button></div>
      <p class="side-wait-note" id="side-wait-note" hidden>請先在上方選「我負責」哪一方，選好才能點擊計分。</p>`:''}
      <div class="score-sides">${sidesInMatch.map((side,i)=>{
        const card=scoring.read(record['card'+side]);
        return `<fieldset class="score-side" id="fs-${side}"><legend>${knockout?`<b class="side-tag">${side} 方</b> `:''}${esc(names[i]||side+' 方（隊伍待確認）')}</legend>
          <output id="score-${side}" class="score-preview"></output>
          ${knockout?'<p class="side-other-note">由另一位計分員負責，這裡只顯示總分（會即時更新）。</p>':''}
          ${holes(side)}
          <div class="tap-grid" aria-label="九宮格入網球數（點擊 +1）">${Array.from({length:9},(_,i)=>cell(side,i,card)).join('')}</div>
          <div class="steppers">
          ${stepper(side,'lit','亮燈小洞進球（計分）',card?.lit??'')}
          ${stepper(side,'hole','小洞不計分（未亮／60 秒後）',card?.hole??'')}
          ${stepper(side,'miss','得分區內未入網',card?.miss??'')}
          ${stepper(side,'yellow','黃牌',card?.yellow??'')}
          ${stepper(side,'rescue','剩餘救援卡',card?.rescue??3)}
          </div>
          <button type="button" class="ghost tap-undo" data-tap="${side}" data-key="undo">↶ 復原上一步</button>
          <div class="score-options">
          ${!knockout?number('input'+side+'seconds','完成時間（秒）',card?.seconds??180,180)+'<button type="button" class="minor fill-seconds" id="fill-seconds" hidden></button>':''}
          <label>裁判判決<select name="input${side}outcome">${Object.entries(scoring.outcomes).map(([key,label])=>`<option value="${key}"${key===(card?.outcome||'normal')?' selected':''}>${label}</option>`).join('')}</select></label>
          </div>
        </fieldset>`;
      }).join('')}</div><p class="caption" id="score-decision" role="status"></p>
      ${canConfirm()?'<button type="button" class="ghost score-reset" id="score-reset">⟲ 分數歸零（主裁判）</button>':''}
    </section>`;
  }
  function formScores(data,record) {
    const knockout=record.match==='knockout';
    for(const side of knockout?['A','B']:['A']){
      const value=key=>data.get('input'+side+key);
      const grid=Array.from({length:9},(_,i)=>value(i));
      const outcome=value('outcome');
      const entered=grid.some(n=>n!=='')||['lit','hole','miss','yellow'].some(key=>value(key)!=='')||outcome!=='normal';
      if(!entered){
        if(record['card'+side])record['score'+side]='';
        record['card'+side]='';
        continue;
      }
      record['card'+side]=JSON.stringify({
        grid:grid.map(Number),lit:Number(value('lit')),hole:Number(value('hole')),miss:Number(value('miss')),yellow:Number(value('yellow')),
        rescue:Number(value('rescue')||3),seconds:Number(value('seconds')||180),outcome
      });
    }
    return [scoring.scoreSide(record,'A'),knockout?scoring.scoreSide(record,'B'):null];
  }
  // 主裁判把整場成績清回尚未計分：計分明細、得分、名次／勝者、簽認、亮燈小洞都清空，成績狀態回到待確認。
  // 直接以伺服器上的最新值為基準送出，不會被別人剛同步的點擊擋成衝突；修改歷史仍保留歸零前的內容。
  const resetKeys=['cardA','cardB','scoreA','scoreB','scoredTeamA','scoredTeamB','winner','rank','signoff','target','resultStatus'];
  async function resetScores() {
    if(!canConfirm()||!original||saving)return;
    if(drafting)return toast('正在同步，請稍後再按一次');
    if(!confirm('確定把「'+(original.title||original.id)+'」的分數全部歸零？\n計分明細、得分、名次／勝者、簽認都會清空，成績改回待確認（修改歷史會保留）。'))return;
    clearTimeout(draftTimer);draftTimer=null;draftAgain=false;
    const id=original.id, latest=find(id)||original;
    const target=key=>key==='resultStatus'?pending:'';
    const keys=resetKeys.filter(key=>(latest[key]??'')!==target(key));
    if(!keys.length){openEditor(latest,'score');return toast('這場已經是 0 分');}
    saving=true;$('save').disabled=true;$('edit-error').textContent='';
    try{
      const res=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type:latest.type,
        changes:Object.fromEntries(keys.map(key=>[key,target(key)])),base:Object.fromEntries(keys.map(key=>[key,String(latest[key]??'')]))})});
      if(res.status===401)return toLogin();
      const data=await res.json();
      if(!res.ok){if(data.state){setState(data.state);render();}return $('edit-error').textContent=(data.error||'歸零失敗')+(res.status===409?'，請再按一次。':'');}
      setState(data);render();
      saving=false;
      const fresh=find(id);
      if(fresh&&$('editor').open)openEditor(fresh,'score');
      toast('已歸零並同步');
    }catch{$('edit-error').textContent='連線失敗，分數沒有歸零，請再按一次。';}
    finally{saving=false;$('save').disabled=tapLocked;}
  }
  const scoreRecommendation = rules.recommendation;
  function refreshScores() {
    paintTaps();
    const data=new FormData($('form'));
    const record={...edited,target:data.get('target')||'',multiplier:data.get('multiplier')||'',rank:data.get('rank')??edited.rank??''};
    const [a,b]=formScores(data,record);
    for(const [side,result] of [['A',a],['B',b]]){
      const output=$('score-'+side);
      if(!output)continue;
      output.textContent=result?.error||(result?
        '總分 '+result.total+' ｜ 九宮格 '+result.base+' ＋ 亮燈小洞 '+result.bonus+
        (record.match==='knockout'?' ＋ 連線 '+result.connectionPoints+'（同分比較 '+result.connectionCount+' 條）':'')+
        (result.multiplier>1?' ｜ 加乘 ×'+result.multiplier:'')+' ｜ 實際入網 '+result.net:
        record['score'+side]?'既有總分 '+record['score'+side]+'（尚無投球明細）':'待輸入球數');
    }
    const recommendation=scoreRecommendation(a,b,sides(record));
    const conflicts=rules.rankConflicts(records,record);
    $('score-decision').textContent=conflicts.length?'⚠ 第 '+record.rank+' 名與計分順序不符（對照已確認的 '+conflicts.join('、')+'）。若是主裁裁決，請在計分備註記錄依據。':
      recommendation?'依計分與同分規則，建議勝者：'+recommendation:
      a&&b&&!a.error&&!b.error?'若同分項目仍完全相同，由總裁判抽籤。雙方皆失格或棄權時，請填寫主裁裁決。':'';
    $('score-decision').classList.toggle('warn',conflicts.length>0);
  }
  // 主審移除／復原場次：只加一個標記，資料都保留，修改歷史記下是誰移除的。
  async function removeMatch(id,remove) {
    const r=find(id);
    if(!r||!canConfirm())return;
    const label=r.match==='ranking'?'排名賽 · '+r.team:r.title;
    if(remove&&!confirm('從賽程移除「'+label+'」？\n這場會從成績、計時選單、觀賽畫面與字卡消失（資料保留，可以在「已移除的場次」復原）。'+(r.match==='ranking'?'\n排名賽少一場：剩下的場次全部確認後，名次照樣自動帶入。':'')))return;
    try{
      const res=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type:r.type,changes:{removed:remove?'1':''},base:{removed:r.removed||''}})});
      if(res.status===401)return toLogin();
      const data=await res.json();
      if(data.state)setState(data.state);else if(res.ok)setState(data);
      render();
      toast(res.ok?(remove?'已移除「':'已復原「')+label+'」':(data.error||'沒有成功，請再按一次'));
    }catch{toast('連線失敗，請再按一次');}
  }
  function rankingSuggestion() {
    const rows=records.filter(r=>r.match==='ranking'&&!rules.removed(r));
    if(rows.length<2||rows.length>teams.length||rows.some(r=>r.resultStatus!=='已確認'||!r.cardA))return '';
    const ranked=rows.map(r=>({team:r.team,score:scoring.scoreSide(r,'A')}));
    if(ranked.some(r=>!r.score||r.score.error))return '';
    ranked.sort((a,b)=>scoring.compare(b.score,a.score));
    return notice('依已確認計分表建議排序　'+ranked.map((entry,i)=>{
      const tied=(i>0&&!scoring.compare(entry.score,ranked[i-1].score))||(i<ranked.length-1&&!scoring.compare(entry.score,ranked[i+1].score));
      return esc(entry.team)+' '+(tied?'（同分待主裁）':'第 '+(i+1)+' 名');
    }).join(' ／ ')+'。五場都確認後，空白的名次會自動帶入；同分的隊伍請主裁抽籤後在場次中填寫。');
  }
  const common = [['title','名稱','required'],['status','狀態',statuses],['notes','備註','area']];
  const timing = [['period','時段',periods],['time','原訂時間'],['category','工作類別',kinds],['owner','負責人／職務']];
  function fieldsFor(r,mode) {
    const teamOptions = teamNames();
    const teamField=['team','隊伍',teamOptions];
    if(mode==='score') {
      const names=sides(r);
      return [
        ...(r.match==='knockout'?[['winner','勝者（主裁確認）',names.filter(Boolean)]]:[['rank','排名',['1','2','3','4','5']]]),
        ['resultStatus','成績狀態',canConfirm()?[pending,'進行中','已確認']:[pending,'進行中']],
        ['signoff','簽認／主裁確認'],
        ['scoreNotes','計分明細、違規、同分或異議','area']
      ];
    }
    const details = {
      schedule:[...timing,teamField,['teamB','另一隊／待命隊伍',teamOptions],['actual','實際時間'],...(r.match?[['checkIn','本場檢錄／急停／球數／場地復原','area']]:[])],
      team:[['school','學校'],['robot','機器人'],['operator','操作員'],['contact','聯絡人'],['contactInfo','聯絡方式'],['arrival','到場時間'],['checkIn','設備／安全檢錄','area']],
      staff:[...timing,['contactInfo','聯絡方式']],
      task:[...timing,teamField,['handoff','接手人'],['actual','實際完成時間']],
      incident:[['kind','紀錄類型',['備案','臨時異動','延誤','場地復原','安全事件']],...timing,teamField,['actual','實際處置／場地決議','area'],['impact','影響、延誤或調整','area'],['handoff','通知對象／交接']],
      media:[['period','時段',periods],teamField,['owner','拍攝者'],['mediaType','媒體類型',['照片','影片','照片／影片']],['matchRef','場次',records.filter(x=>x.match).map(x=>x.id)],['url','照片或影片連結','url']]
    };
    return [common[0],...details[r.type],common[1],common[2]];
  }
  let editMode='';
  const extraLabels={timer:'計時',cardA:'A 方計分明細',cardB:'B 方計分明細',scoreA:'A 方得分',scoreB:'B 方得分',target:'亮燈小洞',multiplier:'第 5 名首輪加乘',scoredTeamA:'計分時的隊伍',scoredTeamB:'計分時的隊伍'};
  const labelOf = key=>([...fieldsFor(edited,''),...(edited.match?fieldsFor(edited,'score'):[])].find(([k])=>k===key)||[])[1]||extraLabels[key]||key;
  const lastEdited = r=>r.editedBy?'最後修改：'+r.editedBy+(r.editedAt?' · '+range.format(new Date(r.editedAt)):''):'';
  const sameRecord = (a,b)=>[...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>(a[k]??'')===(b[k]??''));
  // 只比對這次真正改動的欄位；伺服器會把它們合併到最新版本上。
  const changedKeys = (record,base)=>Object.keys(record).filter(key=>!['id','type','editedBy','editedAt'].includes(key)&&(record[key]??'')!==((base||{})[key]??''));
  function noteEditorChanges() {
    if(!original||!$('editor').open||saving)return;
    adoptShared();
    const latest=find(original.id);
    // 開始計時會自動把狀態改成進行中；只差狀態時不提示（儲存時也不會覆蓋）。
    const quiet=['status','editedBy','editedAt'];
    if(!latest||sameRecord({...latest,...Object.fromEntries(quiet.map(k=>[k,'']))},{...original,...Object.fromEntries(quiet.map(k=>[k,'']))}))return;
    $('edit-note').textContent=(latest.editedBy||'其他人')+' 剛更新了這筆紀錄。儲存時只會寫入你改動的欄位；若改到同一欄位，會先提醒你。';
    $('edit-note').classList.add('changed');
  }
  // 修改歷史：計分明細只顯示摘要，其他欄位顯示前後值。
  function describe(key,value) {
    if(!value)return '（空白）';
    if(/^card[AB]$/.test(key)){
      const card=scoring.read(value);
      if(!card)return '（明細）';
      return '九宮格 '+card.grid.join('/')+(card.lit?' · 亮燈小洞 '+card.lit:'')+(card.hole?' · 小洞不計分 '+card.hole:'')+(card.miss?' · 未入網 '+card.miss:'')+(card.yellow?' · 黃牌 '+card.yellow:'')+(card.outcome!=='normal'?' · '+scoring.outcomes[card.outcome]:'');
    }
    return value.length>60?value.slice(0,60)+'…':value;
  }
  async function loadHistory(id) {
    const box=$('history-list');
    try {
      const res=await fetch('/api/history?id='+encodeURIComponent(id),{cache:'no-store'});
      if(res.status===401)return toLogin();
      if(!res.ok)throw Error();
      const {history}=await res.json();
      if(!$('history-list')||box!==$('history-list'))return;
      box.innerHTML=history.length?'<ol>'+history.map(h=>`<li><span class="time">${esc(range.format(new Date(h.at)))}</span> <strong>${esc(h.by)}</strong>${h.role?'（'+esc(roleLabels[h.role]||h.role)+'）':''}　${esc(labelOf(h.field))}：<del>${esc(describe(h.field,h.before))}</del> → <ins>${esc(describe(h.field,h.after))}</ins></li>`).join('')+'</ol>':'這筆紀錄還沒有修改過。';
    } catch { box.textContent='無法讀取修改歷史，請稍後再試。'; }
  }
  function toast(message) {
    $('toast').textContent=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').textContent='';},2500);
  }
  function openEditor(record,mode='',isNew=false) {
    edited={...record};original=isNew?null:{...record};editMode=mode;
    $('edit-note').textContent=lastEdited(record);
    $('edit-note').classList.remove('changed');
    if(mode==='score'&&record.match==='knockout'&&record.cardA&&record.scoredTeamA){
      const names=sides(record);
      if(record.scoredTeamA!==names[0]||record.scoredTeamB!==names[1]){
        edited={...record,cardA:'',cardB:'',scoreA:'',scoreB:'',winner:'',signoff:'',resultStatus:pending};
      }
    }
    $('edit-title').textContent=mode==='score'?'計分 · '+record.title:titles[record.type]+' · '+(record.title||'新增');
    $('edit-error').textContent='';
    $('fields').innerHTML=(mode==='score'?scoreInputs(edited):'')+fieldsFor(edited,mode).map(([key,label,type])=>{
      const value=(mode==='score'&&key==='resultStatus'?scoreState(edited):edited[key])||'';
      if(Array.isArray(type)){
        const choices=value&&!type.includes(value)?[...type,value]:type;
        const options=opts(choices,value,'待確認／未指定');
        const matchOptions=key==='matchRef'?options.replace(/>([RK][0-9]+)<\/option>/g,(original,id)=>'>'+esc(find(id)?.title||id)+'</option>'):options;
        return `<label>${esc(label)}<select name="${key}">${matchOptions}</select></label>`;
      }
      if(type==='area')return `<label class="full">${esc(label)}<textarea name="${key}" maxlength="3000" placeholder="待確認">${esc(value)}</textarea></label>`;
      const inputType=['url','number'].includes(type)?type:'text';
      return `<label${key==='title'?' class="full"':''}>${esc(label)}<input name="${key}" type="${inputType}" value="${esc(value)}" maxlength="3000" ${type==='required'?'required':''} placeholder="待確認"></label>`;
    }).join('')+(isNew?'':'<details class="history full" id="history"><summary>修改歷史</summary><div id="history-list" class="caption">讀取中…</div></details>');
    if(!isNew)$('history').addEventListener('toggle',()=>{if($('history').open)loadHistory(record.id);});
    // 已確認的成績只有主裁判能改；計分員打開時唯讀。
    const locked=mode==='score'&&!canConfirm()&&record.resultStatus==='已確認';
    tapLocked=locked;
    clearTimeout(draftTimer);draftTimer=null;draftAgain=false;draftHold.clear();holdBy='';draftSent={};
    if(mode==='score')draftNote(locked?'':'每次點擊都會即時同步，觀賽畫面顯示暫定分數；最後仍由主裁判確認。');
    if(mode==='score')refreshScores();
    $('editor').showModal();paintTimer();
    $('save').disabled=locked;
    if(locked)$('edit-note').textContent='這場成績已由主裁判確認，只有主裁判能修改。';
    else if(mode==='score'&&!canConfirm())$('edit-note').textContent='登錄計分明細後，請主裁判確認成績。'+(lastEdited(record)?' '+lastEdited(record):'');
  }
  // 關閉前把還沒送出的點擊送出去，即時計分與畫面一致。
  const close=()=>{if(saving)return;if(draftTimer){clearTimeout(draftTimer);draftTimer=null;saveDraft();}$('editor').close();};
  $('close').onclick=close;
  $('cancel').onclick=close;
  $('editor').addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button)return;
    if(button.dataset.team!==undefined){$('team').value=button.dataset.team;if(!button.dataset.tab)render();}
    if(button.dataset.tab)selectTab(button.dataset.tab);
    if(button.dataset.edit){const record=find(button.dataset.edit);if(record)openEditor(record,button.dataset.mode);}
    if(button.dataset.revoke)revokeDevice(button.dataset.revoke,button.dataset.revokeName);
    if(button.dataset.personCreate!==undefined)createPerson();
    if(button.dataset.personAction)personAction(button.dataset.personAction,button.dataset.personId,button.dataset.personName);
    if(button.dataset.personReveal){const id=button.dataset.personReveal;revealed.has(id)?revealed.delete(id):revealed.add(id);render();}
    if(button.dataset.devicesRefresh!==undefined)loadDevices();
    if(button.dataset.timer)timerAction(button.dataset.timer);
    if(button.dataset.remove)removeMatch(button.dataset.remove,true);
    if(button.dataset.restore)removeMatch(button.dataset.restore,false);
    if(button.id==='score-reset')resetScores();
    if(button.id==='fill-seconds'&&!tapLocked){const input=$('form').elements.inputAseconds;input.value=button.dataset.seconds;refreshScores();scheduleDraft();toast('已帶入計時 '+button.dataset.seconds+' 秒');}
    if(button.dataset.add)openEditor({type:button.dataset.add,id:crypto.randomUUID(),status:pending,period:$('period').value,team:$('team').value,category:button.dataset.add==='media'?'攝影':$('category').value},'',true);
  });
  document.addEventListener('input',event=>{
    if(event.target.id==='person-name')personDraft.name=event.target.value;
    if(event.target.id==='person-role')personDraft.role=event.target.value;
  });
  document.addEventListener('change',event=>{
    if(event.target.id==='timer-match'){timerPick=event.target.value;$('timer-teams').innerHTML=fieldTeamsHtml(find(timerPick));paintTimer();}
    if(event.target.id==='timer-sound')setSound(event.target.checked);
  });
  $('form').addEventListener('input',()=>{if($('score-A')){refreshScores();scheduleDraft();}});
  $('form').addEventListener('click',event=>{
    const pick=event.target.closest('button[data-side-pick]');
    if(pick){chooseSide(pick.dataset.sidePick);return;}
    const button=event.target.closest('button[data-tap]');if(button){tap(button);scheduleDraft();}
  });
  $('form').addEventListener('submit',async event=>{
    event.preventDefault();
    if(saving)return;
    const formData=new FormData(event.target);
    const record={...edited,...Object.fromEntries([...formData].filter(([key])=>!key.startsWith('input')).map(([key,value])=>[key,value.trim()]))};
    record.status ||= pending;
    const reject=message=>{$('edit-error').textContent=message;};
    if(formData.has('resultStatus')){
      const [a,b]=formScores(formData,record);
      if(a?.error||b?.error)return reject(a?.error||b?.error);
    }
    // 規則與伺服器共用：先在前端檢查，伺服器合併到最新版本後會再檢查一次。
    rules.prepare(records,record,changedKeys(record,original));
    const problem=rules.check(records,record,original,changedKeys(record,original));
    if(problem)return reject(problem);
    const keys=changedKeys(record,original);
    if(original&&!keys.length){$('editor').close();return toast('沒有變更');}
    const changes=Object.fromEntries(keys.map(key=>[key,String(record[key]??'')]));
    const base=original?Object.fromEntries(keys.map(key=>[key,String(original[key]??'')])):{};
    saving=true;$('save').disabled=true;$('edit-error').textContent='';
    try{
      const res=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:record.id,type:record.type,isNew:!original,changes,base})});
      if(res.status===401)return toLogin();
      const data=await res.json();
      if(res.status===409&&data.conflicts){
        setState(data.state);render();
        // 保留表單內容；把衝突欄位的基準改成目前值，再按一次儲存即會以自己的內容覆蓋。
        data.conflicts.forEach(key=>{original[key]=data.current[key]??'';draftHold.add(key);});
        const shown=value=>{const text=String(value||'（空白）');return text.startsWith('{')?'已有計分明細':text.length>30?text.slice(0,30)+'…':text;};
        return reject(otherName(data.current.editedBy)+' 剛修改了：'+data.conflicts.map(key=>labelOf(key)+'（目前為「'+shown(data.current[key])+'」）').join('、')+
          '。你的輸入仍保留在表單中。核對後再按一次「儲存紀錄」，會以你的內容覆蓋這些欄位；不想覆蓋請按取消。');
      }
      if(res.status===409){if(data.state){setState(data.state);render();}return reject(data.error||'資料已有更新，請重新開啟紀錄。');}
      if(!res.ok)return reject(data.error||'儲存失敗，請重試。');
      setState(data);$('editor').close();render();
      toast('已儲存並同步');
    }catch{reject('連線失敗，表單內容仍保留，請再按一次儲存。');}
    finally{saving=false;$('save').disabled=false;}
  });
  render();
  refresh();
}
