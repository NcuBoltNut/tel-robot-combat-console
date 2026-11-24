@echo off
rem TEL console: start the watchdog hidden. Put a SHORTCUT to this file in the Startup folder (Win+R, shell:startup).
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0run-tel.ps1"
