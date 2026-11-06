@echo off
cd /d "%~dp0"
echo.
echo === Linkfly: iniciar ===
where docker >nul 2>&1
if errorlevel 1 goto semdocker
docker info >nul 2>&1
if errorlevel 1 goto dockerfechado
if not exist .env goto gerar
findstr /r /c:"^EVO_KEY=." .env >nul
if errorlevel 1 goto antigo
findstr /r /c:"^DB_SENHA=." .env >nul
if errorlevel 1 goto antigo
findstr /r /c:"^ADMIN_EMAIL=." .env >nul
if errorlevel 1 goto antigo
goto baixar0
:antigo
echo.
echo O arquivo .env esta incompleto ou e de uma tentativa antiga.
echo Vou guardar uma copia como .env.antigo e criar um novo com senhas novas.
docker compose -f docker-compose.local.yml down -v
if exist .env.antigo del .env.antigo
ren .env .env.antigo
:gerar
echo.
set /p EMAIL=Digite o seu e-mail de administrador e aperte Enter: 
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gerar-env.ps1" -Email "%EMAIL%"
if not exist .env goto erroenv
findstr /r /c:"^EVO_KEY=." .env >nul
if errorlevel 1 goto erroenv
findstr /r /c:"^DB_SENHA=." .env >nul
if errorlevel 1 goto erroenv
:baixar0
if not exist dados mkdir dados
set N=0
:baixar
set /a N+=1
echo.
echo Baixando os programas (tentativa %N% de 4). Na primeira vez demora de 5 a 15 minutos. Aguarde...
docker compose -f docker-compose.local.yml pull evolution postgres redis
if not errorlevel 1 goto subir
if %N% GEQ 4 goto erro
echo.
echo A internet ou o Docker falhou no meio do download. Esperando 30 segundos para tentar de novo...
timeout /t 30 /nobreak >nul
goto baixar
:subir
echo.
echo Ligando o sistema...
docker compose -f docker-compose.local.yml up -d --build
if errorlevel 1 goto erro
echo.
echo Pronto! Abrindo o painel no navegador: http://localhost:3000
start http://localhost:3000
echo.
echo Crie primeiro a SUA conta de administrador. O codigo de convite esta no arquivo .env (linha CONVITE=).
echo Para as outras pessoas testarem, use o arquivo COMPARTILHAR.bat
pause
exit /b 0
:semdocker
echo.
echo Falta instalar o Docker Desktop: https://www.docker.com/products/docker-desktop
echo Instale, abra o Docker Desktop, espere ele ficar pronto e rode este arquivo de novo.
pause
exit /b 1
:dockerfechado
echo.
echo O Docker Desktop esta fechado. Abra-o, espere ele ficar pronto e rode este arquivo de novo.
pause
exit /b 1
:erroenv
echo.
echo Nao consegui criar o arquivo .env. Me mande uma foto desta tela.
pause
exit /b 1
:erro
echo.
echo Nao deu certo. Reinicie o Docker Desktop (icone da baleia, botao direito, Restart),
echo espere ele ficar pronto e rode este arquivo de novo. Se repetir, rode o VER-ERROS.bat
echo e me mande uma foto da tela.
pause
exit /b 1
