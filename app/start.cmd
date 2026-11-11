@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js nao encontrado.
  echo  Instale a versao LTS em https://nodejs.org e execute este arquivo de novo.
  echo.
  pause
  exit /b 1
)

node server\main.js --open
if errorlevel 1 pause
