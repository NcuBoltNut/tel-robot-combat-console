CREATE TABLE IF NOT EXISTS tel_console (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  records TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tailscale 專用埠的登入裝置；token 只存雜湊值。code_print 記錄登入時用的通行碼指紋，更換通行碼後自動失效。
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  code_print TEXT NOT NULL,
  ip TEXT,
  agent TEXT,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT,
  person_id TEXT
);

-- 修改歷史：每個變動的欄位一列，處理異議時查「原本是多少、誰改的」。
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  field TEXT NOT NULL,
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  by TEXT NOT NULL,
  role TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_record ON history (record_id, seq);

-- 人員名單：每人一組個人通行碼。role 為 edit（計分）或 referee（主裁判／總召，最高權限）。停用後該人的登入立即失效。
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  disabled_at TEXT
);

-- 比賽計時：只有一列。只有主裁判／總召能操作，控制台與觀賽畫面每次輪詢一併取得。
-- data 為 JSON：mode（idle／prep／match／repair）、matchId、duration（秒）、elapsed（暫停前累計毫秒）、since（開始跑的時間點，暫停時為 null）等。
CREATE TABLE IF NOT EXISTS timer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  data TEXT NOT NULL
);
