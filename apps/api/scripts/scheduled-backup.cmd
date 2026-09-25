@echo off
rem Runs the scheduled SAMTEC backup from wherever this repository is checked out.
rem A scheduler points at this file; everything it does is in scripts/scheduled-backup.ts.
cd /d "%~dp0..\..\.."
call pnpm --filter @samtec/api db:backup:scheduled
