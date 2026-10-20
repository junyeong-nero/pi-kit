# setup.ps1 must leave the developer's SDK and NuGet setup alone and keep the server SDK off the machine PATH.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$setup = Get-Content (Join-Path $repo 'scripts/setup.ps1') -Raw
foreach ($name in @('DOTNET_ROOT', 'DOTNET_ROOT_X64', 'DOTNET_HOST_PATH', 'DOTNET_MULTILEVEL_LOOKUP', 'DOTNET_CLI_HOME', 'NUGET_PACKAGES', 'NUGET_HTTP_CACHE_PATH', 'RestoreConfigFile', 'RestoreSources', 'NuGetAudit', 'MSBUILD_EXE_PATH')) {
    if ($setup -match "\b$name\b") { throw "setup.ps1 must not set $name" }
}
$pathDirs = [regex]::Match($setup, '(?m)^\$pathDirs = .*$').Value
if (-not $pathDirs) { throw 'Machine PATH folder list not found in setup.ps1' }
if ($pathDirs -match 'runtime\\dotnet') { throw 'Server SDK added to the machine PATH' }
if ($pathDirs -match 'runtime\\node') { throw 'MCP-only Node runtime added to the machine PATH' }
if ($pathDirs -notmatch 'runtime\\python') { throw 'Bundled Python missing from the machine PATH' }
$setupFiles = @(Get-Item (Join-Path $repo 'setup.ps1')) + @(Get-ChildItem (Join-Path $repo 'scripts') -Filter '*.ps1')
foreach ($file in $setupFiles) {
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
}

# Load only the discovery function: this test must never execute setup or change system variables.
$ast = [Management.Automation.Language.Parser]::ParseInput($setup, [ref]$null, [ref]$null)
$finder = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-VisualStudioMSBuild' }, $true)
if (-not $finder) { throw 'Visual Studio MSBuild discovery function not found' }
. ([scriptblock]::Create($finder.Extent.Text))
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('harness-msbuild-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $fixture -Force | Out-Null
    if ($null -ne (Find-VisualStudioMSBuild -ProgramRoots @($fixture))) { throw 'MSBuild was invented on a PC without Visual Studio' }
    foreach ($layout in @('2022\BuildTools\MSBuild\Current\Bin', '2017\Community\MSBuild\15.0\Bin')) {
        $folder = Join-Path $fixture ('Microsoft Visual Studio\' + $layout)
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        $exe = Join-Path $folder 'MSBuild.exe'
        Set-Content -LiteralPath $exe -Value 'discovery fixture'
        if ((Find-VisualStudioMSBuild -ProgramRoots @($fixture, $fixture)) -ne $exe) { throw "MSBuild fallback failed: $layout" }
        Remove-Item -LiteralPath $exe
    }
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
Write-Host 'PowerShell syntax, MSBuild discovery/missing installation, and SDK/NuGet isolation checks passed.'
