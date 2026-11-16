#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Launches the local Zero-WAF Gemini Brain Cognitive NOC Dashboard at http://127.0.0.1:8765/dashboard
    and copies MCP_BEARER_TOKEN from .dev.vars to the Windows Clipboard for instant login.
#>
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerPy = Join-Path $ScriptDir "brain_dashboard_server.py"
$DevVars = Join-Path $ScriptDir ".dev.vars"

if (Test-Path $DevVars) {
    $token = ((Get-Content $DevVars | Where-Object { $_ -match '^MCP_BEARER_TOKEN=' }) -replace '^MCP_BEARER_TOKEN=','').Trim().Trim('"').Trim("'")
    if ($token) {
        $token | Set-Clipboard
        Write-Host "✓ Copied clean 64-char MCP_BEARER_TOKEN from .dev.vars to Clipboard!" -ForegroundColor Green
    }
}

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
    $PythonExe = "python3"
}

& $PythonExe $ServerPy @args
