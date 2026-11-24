@echo off
rem Starts the index and code graph watcher from the repository root and appends
rem its JSON event lines to data\logs\watch.log. Used by the logon scheduled task;
rem run "pnpm build" after pulling changes so dist\ is current.
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
echo {"at":"%DATE% %TIME%","event":"launcher-start"}>> data\logs\watch.log
node dist\cli.js watch >> data\logs\watch.log 2>&1
