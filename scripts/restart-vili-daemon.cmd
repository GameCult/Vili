@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-vili-daemon.ps1" %*
