// 計分規則：以 docs/2026_rule_0903.pdf（2026 TEL 競賽規則，2026/9/3 修訂版）為準。此函式會以 toString() 送到瀏覽器，因此不可引用外部變數。
export function telScoring() {
  const lines = [
    [8,0,4,8],[8,2,4,6],
    [4,0,3,6],[4,1,4,7],[4,2,5,8],
    [2,0,1,2],[2,3,4,5],[2,6,7,8]
  ];
  // absent＝整隊未出賽：比照失格排在最後；排名賽恰好一隊未出賽時改用四隊賽制（見 rules.js fourTeam）。
  const outcomes = {normal:'一般計分',zero:'裁判判定本場 0 分',withdraw:'放棄卡',dq:'紅牌／失格／缺席',absent:'未出賽'};
  const blocked = (card,knockout)=>card.outcome==='dq'||card.outcome==='absent'||(knockout&&card.outcome==='withdraw');
  function read(serialized) {
    try { return JSON.parse(serialized||'null'); } catch { return null; }
  }
  // card：grid＝九宮格 9 格各自的入網數；lit＝亮燈 60 秒內進入亮燈小洞（TEL 加分網框）的球；
  // hole＝進入小洞但不計分的球（未亮燈的小洞，或 60 秒後才進）；miss＝進得分區但沒入網。
  // 小洞獨立於九宮格之外：不佔九宮格每格上限，也不參與連線（規則書 p.11、p.13–14）。
  function calculate(card,knockout,target,multiplier=1) {
    if(!card)return null;
    const cap=knockout?2:3;
    const ballLimit=knockout?18:27;
    const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
    const {grid,lit,miss,yellow,rescue,seconds,outcome}=card;
    const hole=card.hole??0;
    if(!Array.isArray(grid)||grid.length!==9||!grid.every(n=>integer(n,0,ballLimit))||
      !integer(lit,0,ballLimit)||!integer(hole,0,ballLimit)||!integer(miss,0,ballLimit)||!integer(yellow,0,999)||
      !integer(rescue,0,3)||!integer(seconds,0,180)||!Object.hasOwn(outcomes,outcome))
      return {error:'請填寫有效的整數、剩餘救援卡及用時。'};
    const gridBalls=grid.reduce((sum,n)=>sum+n,0);
    const net=gridBalls+lit+hole;
    if(net+miss>ballLimit)return {error:'九宮格、小洞與未入網的得分區球數合計不能超過 '+ballLimit+' 顆。'};
    const base=grid.reduce((sum,n)=>sum+Math.min(n,cap)*2,0);
    const bonus=Math.min(lit,cap)*4;
    let connectionPoints=0;
    let connectionCount=0;
    if(knockout)for(const [points,...cells] of lines){
      const sets=Math.min(...cells.map(i=>grid[i]));
      if(sets)connectionPoints+=points;
      connectionCount+=sets;
    }
    const raw=base+bonus+connectionPoints;
    const total=outcome==='zero'||blocked(card,knockout)?0:Math.max(0,Math.round((raw*multiplier-yellow)*10)/10);
    // 同分比較：亮燈小洞命中 → 命中不同網框數（含亮燈小洞）→（淘汰賽）連線數 → 實際入網數 → 得分區球數 → 黃牌 → 救援卡 →（排名賽）用時
    const frames=grid.filter(Boolean).length+Number(lit>0);
    const metrics=[Number(lit>0),frames,...(knockout?[connectionCount]:[]),net,net+miss,-yellow,rescue,...(knockout?[]:[-(outcome==='withdraw'?180:seconds)])];
    return {total,base,bonus,connectionPoints,connectionCount,net,multiplier,metrics,blocked:blocked(card,knockout)};
  }
  function compare(a,b) {
    const values=[Number(!a.blocked)-Number(!b.blocked),a.total-b.total,...a.metrics.map((n,i)=>n-b.metrics[i])];
    return values.find(n=>n!==0)||0;
  }
  function scoreSide(record,side) {
    const knockout=record.match==='knockout';
    // 友誼賽取消官方排名加乘（修訂版企劃書）：附加賽第 5 名不再 ×1.2，舊資料留下的 multiplier 一律忽略。
    return calculate(read(record['card'+side]),knockout,record.target);
  }
  return {outcomes,read,calculate,compare,scoreSide};
}
