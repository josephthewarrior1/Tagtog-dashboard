@echo off
setlocal
cd /d "%~dp0"
echo TAGTOG by KIM Communication - local preview
echo Buka http://127.0.0.1:4180/ di browser.
echo Biarkan jendela ini terbuka selama portal digunakan.
echo Tekan Ctrl+C untuk menghentikan server.
where python >nul 2>nul
if %errorlevel% equ 0 (
    python -m http.server 4180 --bind 127.0.0.1
) else (
    where py >nul 2>nul
    if errorlevel 1 (
        echo Python 3 belum tersedia. Instal Python atau buka index.html langsung.
    ) else (
        py -3 -m http.server 4180 --bind 127.0.0.1
    )
)
pause
