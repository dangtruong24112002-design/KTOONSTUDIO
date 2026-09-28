@echo off
rem Double-click to open Studio OS in the browser. Close this window to stop it.
cd /d "%~dp0"
".venv\Scripts\python.exe" -m studio
pause
