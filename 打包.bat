@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ES Escucha 2 - 打包

where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)

echo [1/4] 安装依赖...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

echo [2/4] 准备 Electron 运行环境...
rem 新版 npm 默认不运行安装脚本，这里手动准备 Electron；有缓存时不需要联网。网络出错自动重试 3 次。
set tries=0
:electron
if exist "node_modules\electron\dist\electron.exe" goto electron_ok
set /a tries+=1
call npm run setup-electron
if exist "node_modules\electron\dist\electron.exe" goto electron_ok
if %tries% geq 3 goto fail
echo 下载失败，5 秒后重试（第 %tries% 次）...
timeout /t 5 /nobreak >nul
goto electron
:electron_ok

echo [3/4] 运行测试...
call npm test
if errorlevel 1 echo 测试没有全部通过，但不影响打包，继续。

echo [4/4] 打包 exe（使用本地 Electron，不再联网下载）...
call npm run package
if errorlevel 1 goto fail

copy /y "release\ES-Escucha-2.exe" "ES-Escucha-2.exe" >nul
if errorlevel 1 (
  echo 新的 exe 已在 release 文件夹里生成，但没能复制出来：请先关闭正在运行的 ES Escucha 2，再运行一次本文件。
  pause
  exit /b 1
)
echo.
echo 完成！双击本文件夹里的 ES-Escucha-2.exe 即可使用。
pause
exit /b 0

:fail
echo.
echo 出错了。如果是网络错误（504、超时等），稍等一会儿再双击运行一次即可。
echo 仍然不行的话，把上面的错误信息发给我。
pause
exit /b 1
