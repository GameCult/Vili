@echo off
node "%~dp0vili-daemon.mjs" --health --host 127.0.0.1 --port 8824 --state-root "%~dp0..\.vili"
