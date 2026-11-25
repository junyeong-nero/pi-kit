# Run the one-time setup from the extracted bundle root.
param(
    [switch]$Check,
    [switch]$SystemOnly,
    [string]$ErrorLog
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\setup.ps1') @PSBoundParameters
