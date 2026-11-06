@echo off
cd /d "%~dp0"
echo.
echo === Linkfly: recomecar a instalacao ===
echo Isto apaga as conexoes de WhatsApp e o banco interno do Evolution e cria senhas novas.
echo Suas contas do Linkfly e o historico continuam guardados.
echo Na pergunta do e-mail, use o MESMO e-mail de administrador de antes.
echo.
set /p OK=Digite S e aperte Enter para continuar: 
if /i not "%OK%"=="S" goto cancelar
if exist .env docker compose -f docker-compose.local.yml down -v
if exist .env.antigo del .env.antigo
if exist .env ren .env .env.antigo
call "%~dp0INICIAR.bat"
exit /b 0
:cancelar
echo.
echo Cancelado. Nada foi apagado.
pause
