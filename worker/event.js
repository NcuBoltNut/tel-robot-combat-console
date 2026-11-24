// 活動設定：每一場比賽要換的文字都集中在這裡（名稱、日期、地點、主辦、規則版本）。
// 改完重新啟動伺服器即可，不影響資料庫。隊伍名單與賽程時間在 worker/seed.js（或環境變數 TEL_TEAMS）。
// 這裡的值會以 JSON 送到瀏覽器，只能放純文字，不要放通行碼或任何機密。
export const event = {
  brand: 'TEL ROBOT COMBAT',                         // 側欄、觀賽畫面、字卡左上角的大字
  year: '2026',
  name: '2026 TEL Robot Combat',                     // 比賽正式名稱（瀏覽器分頁標題、冠軍卡）
  title: '2026 TEL Robot Combat · 跨校模擬賽暨技術交流', // 控制台首頁副標
  short: '跨校友誼賽',                                // 側欄副標、控制台分頁標題
  watchSubtitle: '跨校模擬賽 · 即時賽況',               // 觀賽畫面左上角副標
  organizer: 'NCU BoltNut Robotics',                 // 主辦單位
  dateLabel: '11.15',                                // 首頁大字日期
  weekday: '日',
  gather: '10:00 集合',                              // 首頁日期下方
  venueFallback: '中央大學機械系候選場地',              // 總覽「比賽場地」卡片，尚未在「異動與備案」填寫實際場地時顯示
  planVersion: '修訂版活動企劃書及附件一、二',           // 控制台頁尾「賽務基準」
  rules: '2026 TEL Robot Combat 規則',                // 總覽「固定競賽節點」說明
  overlayRight: '跨校模擬賽',                          // 直播字卡右上角
  overlayRightSmall: '中央大學',
};
