# Run the one-time setup from the extracted bundle root.
param(
    [switch]$Check,
    [switch]$SystemOnly
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\setup.ps1') @PSBoundParameters
