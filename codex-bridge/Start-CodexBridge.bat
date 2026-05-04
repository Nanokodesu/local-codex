@echo off
chcp 65001 >nul
title Codex Bridge Server
color 0A

echo ===================================================
echo        Codex Bridge - Work Buddy Connector
echo ===================================================
echo.
echo [INFO] Starting local bridge server...
echo [INFO] API Endpoint: http://localhost:8787
echo.
echo [TIP] You can safely minimize this window.
echo [TIP] To stop the server, just close this window.
echo.
echo ---------------------------------------------------

cd /d "%~dp0"
node server.js

pause