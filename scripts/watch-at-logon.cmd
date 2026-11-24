@echo off
rem Starts the index and code graph watcher from the repository root and appends
rem its JSON event lines to data\logs\watch.log. Used by the logon scheduled task;
rem run "pnpm build" after pulling changes so dist\ is current.
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
rem After Stop-ScheduledTask, the previous watcher finishes any running scan or
rem code graph build before exiting, and holds the log until then. Wait for the
rem log to be writable, up to about 3 minutes, so an immediate restart works.
set /a tries=0
:wait_for_log
2>nul (call ) >> data\logs\watch.log && goto start
set /a tries+=1
if %tries% geq 90 exit /b 1
ping -n 3 127.0.0.1 >nul
goto wait_for_log
:start
echo {"at":"%DATE% %TIME%","event":"launcher-start"}>> data\logs\watch.log
rem --stop-on-stdin-close: Stop-ScheduledTask kills only conhost, so the
rem watcher exits when the console it reads from goes away.
node dist\cli.js watch --stop-on-stdin-close >> data\logs\watch.log 2>&1
