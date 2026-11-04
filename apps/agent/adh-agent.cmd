@echo off
rem Switch console to UTF-8, otherwise Chinese log output is garbled.
chcp 65001 >nul
node "%~dp0bin\adh-agent.mjs" %*
