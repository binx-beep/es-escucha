@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ES Escucha 2
if not exist node_modules (
  echo 第一次运行，正在安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( pause & exit /b 1 )
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo 正在准备 Electron 运行环境...
  call npm run setup-electron
  if errorlevel 1 ( pause & exit /b 1 )
)
call npm start
