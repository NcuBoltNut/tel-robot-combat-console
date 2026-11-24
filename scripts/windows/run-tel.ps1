# 賽務控制台看門狗（Windows）：伺服器結束（當機、被關）5 秒後自動重開，同時只跑一份，輸出寫到 <資料夾>\logs\。
# 用法：直接執行本檔，或把同資料夾 tel-console.cmd 的「捷徑」放進「啟動」資料夾（Win+R → shell:startup），登入 Windows 後自動啟動。
# 專案位置自動取本檔往上兩層（scripts\windows\ → 專案根目錄）；也可以用環境變數 TEL_PROJECT 指定。
# 對外埠預設 3080（給 Tailscale 轉入）；可用環境變數 PUBLIC_PORT 改。資料夾預設 %LOCALAPPDATA%\tel-robot-combat；可用 DATA_DIR 改。
$ErrorActionPreference = 'Continue'
$project = if ($env:TEL_PROJECT) { $env:TEL_PROJECT } else { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
if (-not (Test-Path (Join-Path $project 'server.mjs'))) { Write-Error "找不到 server.mjs：$project"; exit 1 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node.exe' }
$data = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'tel-robot-combat' }
$logs = Join-Path $data 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null

# 同一時間只跑一份：已有另一份在跑就離開。
$mutex = New-Object System.Threading.Mutex($false, 'Global\tel-robot-combat-console')
if (-not $mutex.WaitOne(0)) { exit 0 }

if (-not $env:PUBLIC_PORT) { $env:PUBLIC_PORT = '3080' }
while ($true) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Add-Content -Encoding utf8 (Join-Path $logs 'restarts.log') "$stamp start"
  $p = Start-Process -FilePath $node -ArgumentList '--no-warnings', 'server.mjs' -WorkingDirectory $project `
    -RedirectStandardOutput (Join-Path $logs "server-$stamp.out.log") -RedirectStandardError (Join-Path $logs "server-$stamp.err.log") `
    -WindowStyle Hidden -PassThru
  $null = $p.Handle  # 讓 ExitCode 讀得到
  $p.WaitForExit()
  Add-Content -Encoding utf8 (Join-Path $logs 'restarts.log') ((Get-Date -Format 'yyyyMMdd-HHmmss') + " exit $($p.ExitCode)")
  # 只留最近 60 份輸出
  Get-ChildItem $logs -Filter 'server-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 60 | Remove-Item -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}
