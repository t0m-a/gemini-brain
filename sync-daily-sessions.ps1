#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Cross-shell launcher for sync_daily_sessions.py on Windows 11.
    Automatically resolves the real Python 3 binary (bypassing the WindowsApps Store stub).
#>
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SyncPy = Join-Path $ScriptDir "sync_daily_sessions.py"

$PythonExe = $null
$Candidates = @(
    "$env:LOCALAPPDATA\Python\bin\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
)

foreach ($cand in $Candidates) {
    if ($cand -and (Test-Path $cand)) {
        $PythonExe = $cand
        break
    }
}

if (-not $PythonExe) {
    $found = Get-Command python3, python -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notlike "*WindowsApps*" } |
        Select-Object -First 1
    if ($found) {
        $PythonExe = $found.Source
    } else {
        $PythonExe = "python3"
    }
}

& $PythonExe $SyncPy @args
exit $LASTEXITCODE
