@echo off
cd /d "%~dp0"
where cloudflared >nul 2>&1
if errorlevel 1 goto instalar
echo.
echo Procure abaixo o endereco que termina com trycloudflare.com
echo Envie esse endereco para as pessoas do teste.
echo NAO feche esta janela enquanto elas estiverem usando.
echo Se fechar e abrir de novo, o endereco muda.
echo.
cloudflared tunnel --url http://localhost:3000
pause
exit /b 0
:instalar
echo.
echo Instalando o Cloudflared (gratis). Aguarde...
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
echo.
echo Feche esta janela e abra o COMPARTILHAR.bat de novo.
pause
