# 給 AI agent 的交接說明

這是一套機器人模擬賽的賽務控制台（2026 TEL Robot Combat 跨校模擬賽實際使用過）。人類版說明在 [README.md](README.md)，比賽當天的操作在 [docs/event-day-checklist.md](docs/event-day-checklist.md)，2026 年比賽期間做過的修改與原因在 [docs/CHANGELOG-2026.md](docs/CHANGELOG-2026.md)。

使用者（主辦方）用繁體中文溝通；回覆、程式註解與錯誤訊息都用繁體中文。

## 先確認的事

- 執行：`node server.mjs`（Node.js 24 以上，**沒有 npm 套件**，不要加相依套件）。本機 http://127.0.0.1:3000 免登入、擁有主裁判權限。
- 測試：`npm test`（約 1 分半）。**改完程式一定要全部通過才能重啟正式伺服器。**
- 正式資料在 `%LOCALAPPDATA%\tel-robot-combat\`（或 `DATA_DIR`）。`tel-console.sqlite` 與 `access-codes.json` 內含通行碼與成績：**不要讀出、印出、commit 或上傳通行碼**。
- 比賽進行中**不要重啟伺服器**。要重啟前先查 `GET /api/state` 的 `timer.running`，在計時中就等。

## 架構重點（改程式前必讀）

- `worker/index.js` 是 Cloudflare Worker 格式的 API；`server.mjs` 是 Node 伺服器，處理本機埠／對外埠、登入、OBS 連結、音效檔，再把請求交給 worker。資料庫用 `d1.mjs` 把 node:sqlite 包成 D1 介面。
- **`worker/scoring.js`、`rules.js`、`timer.js`、`client.js`、`spectator.js`、`overlay.js` 會被 `toString()` 送到瀏覽器執行**：函式內**不能引用函式外的變數或 import**。需要的值用參數傳入（例如 `client({teams, ..., event}, scoring, rules, clockRules)`、`spectator(timing, event)`、`overlay(timing, event)`，在 `worker/index.js` 組字串）。
- 這幾個檔案也會被 Python 或 sed 之類工具編輯：**JavaScript 字串裡不要寫入真正的換行**（要用 `\n`），否則整個前端載入失敗。改完跑 `node --check worker/client.js`。
- 前端存檔格式：`PUT /api/state {id, type, changes, base}`。伺服器只合併有改動的欄位；欄位被別人改過回 409；權限不足回 403。新增欄位不用改資料庫結構（整份賽務資料存成一個 JSON）。
- 計時狀態存在 `timer` 表，`field` 是主審「指定上場」的場次；所有畫面每 0.5 秒輪詢，伺服器在版本沒變時回 204。
- 權限：`view`（檢視）、`camera`（攝影／直播字卡）、`edit`（計分）、`referee`（主裁判／總召）。伺服器端在 `worker/index.js`（路徑限制、`save()` 的欄位權限）與 `server.mjs` 檢查；前端的隱藏按鈕不算安全機制。
- 活動文字在 `worker/event.js`；隊伍名單在 `worker/seed.js`（或 `TEL_TEAMS`）。`seed.js` **只對空的資料庫有效**。
- 觀賽與字卡只拿 `/api/public`，裡面不能有聯絡方式、備註、簽認、工作人員資料。

## 改程式的安全流程（2026 年比賽當天實際使用）

1. 複製一份「備援」資料夾，用不同的埠與資料夾跑：`PORT=3100 PUBLIC_PORT=3180 DATA_DIR=<另一個資料夾>`。資料可以用 `VACUUM INTO` 從正式資料庫複製一份（唯讀開啟正式檔）。
2. 在備援改程式、補測試，`npm test` 全過。影響賽程或計分流程時，再寫一支模擬腳本跑完整比賽日（未收錄在 repo）：用個人通行碼從對外埠登入主審、計分 A／B，依序「指定上場 → 準備 → 比賽 → 逐球點擊（PUT cardA／cardB）→ 確認」，同時讓 60～150 個檢視身分每 0.5 秒輪詢 `/api/public`，最後比對名次、淘汰賽勝者、錯誤數與延遲。2026 年的結果：150 人同時觀看 p95 約 30 ms、0 錯誤。
3. 備份正式程式資料夾，把改動的檔案複製過去，在正式資料夾再跑一次 `npm test`。
4. 確認沒有在計時，再重啟（看門狗會在 5 秒內自動重開）。重啟後確認 `/` 回 200、資料的 revision 與重要成績都還在。

## 測試注意

- `npm test` 用 `tests/five-teams.env` 設 `TEL_TEAMS` 為五隊（舊測試以五隊撰寫）；正式預設是四隊，四隊流程在 `tests/four-teams.test.mjs`。
- 瀏覽器測試共用同一個伺服器與資料：**不要假設某場次的初始值**，以操作前讀到的值為基準。等待畫面狀態時用 `until(...)`／`waitFor(...)`，不要一載入就讀（曾因「頁面框架已出現、資料還沒到」而偶發失敗）。
- 偶發失敗：先單獨重跑那個檔案（`node --env-file=tests/five-teams.env --test tests/browser.test.mjs`）多次；只有反覆失敗才是真問題。
- 測試不涵蓋真正的 Tailscale Funnel 與實機手機瀏覽器。

## 不要做的事

- 不要把 Tailscale 指到 3000（本機免登入埠）。
- 不要讓兩台電腦同時當主控（資料庫沒有同步）。
- 不要把 `sounds/*.mp3`、`docs/*.pdf`（第三方著作）、資料庫、`access-codes.json` 加進 git。
- 不要在使用者沒同意下清除或覆蓋正式資料；清測試資料前先問清楚範圍，並先備份。
- 比賽前一天與當天盡量不要改程式；必要時照上面的安全流程。
