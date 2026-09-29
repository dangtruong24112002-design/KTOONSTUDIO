@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 goto usepy
where python >nul 2>nul
if not errorlevel 1 goto usepython
echo May chua co Python 3. Cai tai https://www.python.org/downloads/ (tick "Add python.exe to PATH"), roi mo lai file nay.
goto end
:usepy
py -3 app.py
goto end
:usepython
python app.py
:end
echo.
pause
