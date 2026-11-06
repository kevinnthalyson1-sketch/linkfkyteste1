@echo off
cd /d "%~dp0"
docker compose -f docker-compose.local.yml logs --tail 80 app evolution
pause
