# 規則文件

計分規則（`worker/scoring.js`）依據 **2026 TEL Robot Combat 官方競賽規則（2026/9/3 修訂版）**。規則 PDF 是主辦方的文件，**不放進 git**；請向主辦方或隊伍取得後放在這裡（例如 `docs/2026_rule_0903.pdf`），方便核對頁碼。

程式碼與測試中引用的頁碼（例如「規則書 p.11」）都指這一版。換新年度規則時：

1. 把新規則放進 `docs/`。
2. 先改 `tests/scoring.test.mjs` 的手算案例（預期值），再改 `worker/scoring.js` 直到測試通過。
3. 同分比較順序在 `worker/scoring.js` 的 `metrics` 與 `compare`。
