// 賽務規則：淘汰賽席位帶入、成績確認條件。
// 前端與伺服器共用同一份。此函式會以 toString() 送到瀏覽器，因此不可引用外部變數。
export function telRules({teams,pending}, scoring) {
  const scoreFields = ['cardA','cardB','scoreA','scoreB','winner','rank','resultStatus','signoff','scoreNotes','target','multiplier','scoredTeamA','scoredTeamB'];
  const find = (records,id)=>records.find(r=>r.id===id);
  // 主審移除的場次（removed='1'）：從賽程、排名、對戰與觀賽畫面消失，可以復原。
  const removed = r=>r?.removed==='1';
  const touchesScore = touched=>touched.some(key=>scoreFields.includes(key));

  // 淘汰賽在隊伍異動後，原本已確認的成績要重新複核。
  function scoreState(records,r) {
    if(r.resultStatus==='已確認'&&r.match==='knockout'){
      const names=sides(records,r);
      if(r.scoredTeamA!==names[0]||r.scoredTeamB!==names[1])return pending;
    }
    return r.resultStatus||pending;
  }
  // 四隊賽制：排名賽恰好一隊判「未出賽」且已確認 → 不舉行附加賽，準決賽 A 改為第 1 名 vs. 第 4 名。
  function fourTeam(records) {
    return teams.length===5&&records.filter(r=>r.match==='ranking'&&r.resultStatus==='已確認'&&scoring.read(r.cardA)?.outcome==='absent').length===1;
  }
  const skipped=(records,r)=>Boolean(r)&&r.id==='K1'&&fourTeam(records);
  // 席位名稱（例如「第 4 名」）；四隊賽制下準決賽 A 的 B 方由「附加賽勝者」改為「第 4 名」。
  const slotLabel=(records,r,side)=>r.id==='K2'&&side==='B'&&fourTeam(records)?'第 4 名':r['side'+side];
  // 依已確認的排名與勝者帶入淘汰賽雙方；尚未確定的席位回傳空字串。
  function sides(records,r) {
    if(!r || !r.match)return [];
    if(r.match==='ranking')return [r.team];
    if(skipped(records,r))return ['',''];
    const qualified = label=>{
      const rank=/^第 ([1-5]) 名$/.exec(label);
      if(rank){
        const eligible=records.filter(x=>x.match==='ranking'&&!removed(x)&&x.resultStatus==='已確認'&&x.rank===rank[1]);
        return eligible.length===1 ? eligible[0].team : '';
      }
      const id={'附加賽勝者':'K1','準決賽 A 勝者':'K2','準決賽 B 勝者':'K3'}[label];
      const preceding=find(records,id);
      if(!preceding || scoreState(records,preceding)!=='已確認')return '';
      const options=sides(records,preceding);
      return options.includes(preceding.winner)?preceding.winner:'';
    };
    return [r.team||qualified(slotLabel(records,r,'A')),r.teamB||qualified(slotLabel(records,r,'B'))];
  }
  function recommendation(a,b,names) {
    if(!a||!b||a.error||b.error||!names[0]||!names[1]||(a.blocked&&b.blocked))return '';
    const order=scoring.compare(a,b);
    return order>0?names[0]:order<0?names[1]:'';
  }
  // 名次與分數矛盾：這隊名次在前卻輸給另一隊已確認的成績（或反過來）。完全同分由主裁抽籤，不算矛盾。
  function rankConflicts(records,record) {
    if(record.match!=='ranking'||!record.rank||!record.cardA)return [];
    const mine=scoring.scoreSide(record,'A');
    if(!mine||mine.error)return [];
    return records.filter(r=>r.id!==record.id&&r.match==='ranking'&&!removed(r)&&r.resultStatus==='已確認'&&r.rank&&r.cardA).filter(r=>{
      const other=scoring.scoreSide(r,'A');
      if(!other||other.error)return false;
      const byScore=Math.sign(scoring.compare(mine,other));
      return byScore!==0&&byScore!==Math.sign(Number(r.rank)-Number(record.rank));
    }).map(r=>r.team);
  }
  // 所有排名賽都已確認後，依計分與同分規則自動帶入名次，回傳 {場次 id: 名次}。
  // 只補空白的名次；完全同分的隊伍留白，由主裁抽籤後手動填寫；已被手動填寫的名次不重複使用。
  function autoRanks(records) {
    // 主審移除的排名賽不算；剩下的全部確認後就帶入（例如剩 3 場就排 1–3 名）。
    const rows=records.filter(r=>r.match==='ranking'&&!removed(r));
    if(rows.length<2||rows.length>teams.length||rows.some(r=>r.resultStatus!=='已確認'||!r.cardA))return {};
    const scored=rows.map(r=>({r,score:scoring.scoreSide(r,'A')}));
    if(scored.some(x=>!x.score||x.score.error))return {};
    scored.sort((a,b)=>scoring.compare(b.score,a.score));
    const taken=new Set(rows.map(r=>r.rank).filter(Boolean));
    const fill={};
    scored.forEach((x,i)=>{
      const tied=(i>0&&!scoring.compare(x.score,scored[i-1].score))||(i<scored.length-1&&!scoring.compare(x.score,scored[i+1].score));
      const rank=String(i+1);
      if(!x.r.rank&&!tied&&!taken.has(rank))fill[x.r.id]=rank;
    });
    return fill;
  }
  function safeLink(url) {
    try {const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol))return parsed.href;} catch {}
    return '';
  }
  // 以其他紀錄的最新狀態檢視這筆紀錄（這筆以新內容取代）。
  const viewWith = (records,record)=>[...records.filter(r=>r.id!==record.id),record];

  // 依規則補上衍生欄位：隊伍名稱、各隊得分、計分時的對戰隊伍、建議勝者。直接修改 record。
  function prepare(records,record,touched) {
    if(record.type==='team'){record.team=record.title;record.category='檢錄';}
    if(!record.match||!touchesScore(touched))return record;
    // 主裁確認成績＝這場比完了：場次狀態從「進行中」改成「已完成」。
    if(touched.includes('resultStatus')&&record.resultStatus==='已確認'&&record.status==='進行中')record.status='已完成';
    const knockout=record.match==='knockout';
    const results={};
    for(const side of knockout?['A','B']:['A']){
      if(record['card'+side]){
        const result=scoring.scoreSide(record,side);
        results[side]=result;
        if(result&&!result.error)record['score'+side]=String(result.total);
      } else if(touched.includes('card'+side)) record['score'+side]='';
    }
    if(knockout&&(record.cardA||record.cardB||record.resultStatus==='已確認')){
      const names=sides(viewWith(records,record),record);
      record.scoredTeamA=names[0]||'';
      record.scoredTeamB=names[1]||'';
      if(record.resultStatus==='已確認'&&!record.winner){
        const recommended=recommendation(results.A,results.B,names);
        if(recommended)record.winner=recommended;
      }
    }
    return record;
  }

  // 回傳錯誤訊息；空字串代表可以儲存。previous 是資料庫裡的舊版（新增時為 null），touched 是這次改動的欄位。
  function check(records,record,previous,touched) {
    const others=records.filter(r=>r.id!==record.id);
    if(record.type==='team'){
      if(previous&&previous.title!==record.title&&teams.includes(previous.title))return '既有隊伍的隊別名稱需保留，以維持賽程關聯。';
      if(others.some(r=>r.type==='team'&&r.team===record.title))return '已有同名隊伍。';
    }
    if(record.url&&!safeLink(record.url))return '影像連結請使用 HTTP 或 HTTPS 網址。';
    if(touched.includes('removed')&&!['','1'].includes(record.removed??''))return '移除標記只能是移除或復原。';
    if(touched.includes('removed')&&!record.match)return '只有比賽場次可以移除。';
    // 淘汰賽手動指定的兩隊：必須是名單上的隊伍，且不能相同。
    if(record.match==='knockout'&&touched.some(key=>key==='team'||key==='teamB')){
      if([record.team,record.teamB].some(name=>name&&!teams.includes(name)))return '請從隊伍名單選擇對戰隊伍。';
      if(record.team&&record.team===record.teamB)return '兩隊不能是同一隊。';
    }
    // 只改備註或時間等欄位時不重新檢查成績，避免隊伍異動後連一般欄位都存不了。
    if(!record.match||!touchesScore(touched))return '';
    if(record.target&&!['1','2','3'].includes(record.target))return '亮燈小洞只能是左、中、右。';
    if(record.multiplier&&!['1','1.2'].includes(record.multiplier))return '首輪加乘只能選 ×1.2 或不加乘。';
    if(record.resultStatus==='已確認'&&skipped(viewWith(records,record),record))return '已有一隊未出賽，改採四隊賽制，不舉行附加賽。';
    const knockout=record.match==='knockout';
    const a=record.cardA?scoring.scoreSide(record,'A'):null;
    const b=knockout&&record.cardB?scoring.scoreSide(record,'B'):null;
    if(a?.error||b?.error)return a?.error||b?.error;
    if(record.resultStatus!=='已確認')return '';
    const names=sides(viewWith(records,record),record);
    if(knockout&&(a||b)){
      if(!a||!b)return '請填完兩隊的九宮格計分明細。';
      const recommended=recommendation(a,b,names);
      if(recommended&&record.winner!==recommended)return '所選勝者與計分或同分順序不符，請複核計分與裁判判決。';
      if(!recommended&&!record.scoreNotes)return '請記錄主裁抽籤結果或其他裁決依據。';
    }
    if(!record.scoreA||!record.signoff)return '確認成績前請填寫得分及主裁簽認。';
    if(record.match==='ranking'&&record.rank&&others.some(r=>r.match==='ranking'&&!removed(r)&&r.rank===record.rank&&r.resultStatus==='已確認'))return '此排名已由另一隊確認，請先複核。';
    const conflicting=rankConflicts(records,record);
    if(conflicting.length&&!record.scoreNotes)return '第 '+record.rank+' 名與計分順序不符（對照 '+conflicting.join('、')+'）。若是主裁裁決，請在計分備註記錄依據。';
    if(knockout&&(!names[0]||!names[1]||names[0]===names[1]||!record.scoreB||!names.includes(record.winner)))return '確認淘汰賽前，請確認兩隊、雙方得分及勝者。';
    if(knockout&&(record.scoredTeamA!==names[0]||record.scoredTeamB!==names[1]))return '計分時的隊伍與目前賽程不符，請重新開啟計分。';
    return '';
  }
  return {removed,scoreFields,scoreState,sides,fourTeam,skipped,slotLabel,recommendation,rankConflicts,autoRanks,safeLink,prepare,check};
}
