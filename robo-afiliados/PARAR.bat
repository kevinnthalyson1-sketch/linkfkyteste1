@echo off
cd /d "%~dp0"
docker compose -f docker-compose.local.yml down
echo.
echo Sistema desligado. Seus dados continuam guardados. Para ligar, use o INICIAR.bat
pause
