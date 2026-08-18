@echo off
REM Shim for cmd.exe. See harness.ps1 / harness for the other shells.
node "%~dp0.harness\bin\harness.mjs" %*
