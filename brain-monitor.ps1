#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Cross-shell launcher for brain_monitor.py on Windows 11 & Linux PowerShell.
    Automatically resolves the real Python 3 binary (bypassing the WindowsApps Store stub).
#>
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MonitorPy = Join-Path $ScriptDir "brain_monitor.py"

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

& $PythonExe $MonitorPy @args
exit $LASTEXITCODE
