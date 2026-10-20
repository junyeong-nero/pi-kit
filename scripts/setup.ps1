# One-time setup so `pi` runs from any folder: machine PATH and variables pointing pi at the bundle's config folder.
# Re-run after moving the bundle folder.
param(
    [switch]$Check,
    # Internal: the elevated child changes machine settings, never another account's user settings.
    [switch]$SystemOnly
)
$ErrorActionPreference = "Stop"
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$BundleRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..")).TrimEnd('\')
# Overlay update: the update ZIP only stages changed files under update\. Apply them on top of the exact base release.
$updateDir = Join-Path $BundleRoot 'update'
$updateInfo = Join-Path $updateDir 'update.json'
if (-not $Check -and -not $SystemOnly -and (Test-Path -LiteralPath $updateInfo -PathType Leaf)) {
    function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
    function Resolve-BundlePath([string]$Relative) {
        $full = [IO.Path]::GetFullPath((Join-Path $BundleRoot ($Relative -replace '/', '\')))
        if ([IO.Path]::IsPathRooted($Relative) -or -not $full.StartsWith($BundleRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path in update: $Relative" }
        return $full
    }
    $update = Get-Content -LiteralPath $updateInfo -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifestPath = Join-Path $BundleRoot 'manifest.json'
    $newManifest = Join-Path $updateDir 'manifest.json'
    $currentSha = if (Test-Path -LiteralPath $manifestPath -PathType Leaf) { Get-Sha256 $manifestPath } else { '' }
    $selfUpdated = $false
    if ($currentSha -eq (Get-Sha256 $newManifest)) {
        Write-Host "Update $($update.version) is already applied."
    } else {
        if ($currentSha -ne $update.base_manifest_sha256) {
            throw "This update applies only on top of the complete $($update.base_version) release. Extract that complete ZIP first, then the update. Nothing was changed."
        }
        $files = @($update.files.PSObject.Properties)
        foreach ($entry in $files) {
            $staged = Join-Path $updateDir ('files\' + ($entry.Name -replace '/', '\'))
            if (-not (Test-Path -LiteralPath $staged -PathType Leaf) -or (Get-Sha256 $staged) -ne $entry.Value) {
                throw "Update file is missing or damaged: $($entry.Name). Extract the update ZIP again. Nothing was changed."
            }
            Resolve-BundlePath $entry.Name | Out-Null
        }
        $removals = @($update.remove | Where-Object { $_ })
        foreach ($relative in $removals) { Resolve-BundlePath $relative | Out-Null }
        # This script is copied last so the running copy stays intact until everything else is in place.
        foreach ($entry in @($files | Sort-Object { $_.Name -eq 'scripts/setup.ps1' })) {
            $target = Resolve-BundlePath $entry.Name
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            Copy-Item -LiteralPath (Join-Path $updateDir ('files\' + ($entry.Name -replace '/', '\'))) -Destination $target -Force
            if ($entry.Name -eq 'scripts/setup.ps1') { $selfUpdated = $true }
        }
        foreach ($relative in $removals) { Remove-Item -LiteralPath (Resolve-BundlePath $relative) -Force -ErrorAction SilentlyContinue }
        Copy-Item -LiteralPath $newManifest -Destination $manifestPath -Force
        Write-Host "Applied update $($update.version): $($files.Count) files updated, $($removals.Count) removed."
    }
    Remove-Item -LiteralPath $updateDir -Recurse -Force
    if ($selfUpdated) {
        # Continue with the updated setup logic.
        & $PSCommandPath @PSBoundParameters
        return
    }
}
$required = @("package.json", "extensions\harness-env\index.ts", "bin\pi\pi.exe", "bin\fd.exe", "bin\rg.exe", "bin\clangd\bin\clangd.exe",
    "extensions\tool-profile\index.ts", "extensions\minimal-footer\index.ts", "docs\tool-guide.md", "skills\plan\SKILL.md", "skills\align\SKILL.md",
    "runtime\python\python.exe", "runtime\python\python313.dll", "runtime\python\python313.zip", "runtime\python\python313._pth",
    "runtime\python\Lib\site-packages\redis\__init__.py", "runtime\python\Lib\site-packages\mcp\__init__.py",
    "runtime\python\Lib\site-packages\tzdata\__init__.py",
    "config\mcp.json", "mcp\build-center\main.py", "mcp\build-center\service.py",
    "runtime\node\node.exe", "runtime\node\LICENSE", "mcp\edge\edge_mcp.py", "config\playwright.json",
    "vendor\extensions\node_modules\@playwright\mcp\cli.js", "vendor\extensions\node_modules\@playwright\mcp\LICENSE",
    "vendor\extensions\node_modules\playwright-core\lib\coreBundle.js",
    "vendor\extensions\node_modules\@tian.zuo\pi-usage\index.ts",
    "config\redis\settings.json", "config\redis\server_IP_mappings.example.json", "config\redis\owners.example.json", "config\redis\requirements.lock",
    "third_party\python\PYTHON-LICENSE.txt", "third_party\python\PACKAGES.json", "third_party\python\NOTICE.md",
    "extensions\harness-env\powershell.ts", "extensions\harness-env\encoding.ts", "extensions\harness-env\file-tools.ts", "vendor\extensions\node_modules\iconv-lite\encodings\tables\cp949.json",
    "bin\svn\bin\svn.exe", "bin\svn\bin\svnadmin.exe", "bin\svn\bin\libsvn_client-1.dll", "bin\svn\bin\vcruntime140.dll", "bin\svn\Licenses\Apache Subversion License.txt",
    "bin\redis\redis-cli.exe", "bin\redis\redis-server.exe", "bin\redis\msys-2.0.dll", "bin\redis\msys-crypto-3.dll", "bin\redis\msys-ssl-3.dll",
    "bin\redis\redis-benchmark.exe", "bin\redis\redis-check-aof.exe", "bin\redis\redis-check-rdb.exe", "bin\redis\redis-sentinel.exe", "bin\redis\RedisService.exe",
    "bin\redis\msys-gcc_s-seh-1.dll", "bin\redis\msys-stdc++-6.dll", "bin\redis\redis.conf", "bin\redis\sentinel.conf", "bin\redis\start.bat",
    "config\redis.local.conf", "third_party\redis\REDIS-COPYING", "third_party\redis\NOTICE.md",
    "third_party\redis\LUA-COPYRIGHT", "third_party\redis\FPCONV-LICENSE.txt", "third_party\redis\REDIS-SERVER-NOTICES.txt",
    "third_party\redis\REDIS-WINDOWS-LICENSE", "third_party\redis\DOTNET-LICENSE.txt", "third_party\redis\DOTNET-THIRD-PARTY-NOTICES.txt",
    "bin\csharp-ls\CSharpLanguageServer.dll", "runtime\dotnet\dotnet.exe", "config\lsp.json",
    "extensions\cpp-csharp-lsp-lite\index.ts", "extensions\cpp-csharp-lsp-lite\lsp-client.ts", "extensions\cpp-csharp-lsp-lite\diagnostics-delta.ts", "extensions\cpp-csharp-lsp-lite\find-symbol.ts", "config\pi-lens.json", "config\settings.json", "config\extensions\subagent\config.json", "config\AGENTS.md",
    "vendor\extensions\node_modules\pi-lens\dist\index.js",
    "vendor\extensions\node_modules\pi-subagents\index.js",
    "vendor\extensions\node_modules\@juicesharp\rpiv-ask-user-question\index.ts", "vendor\extensions\node_modules\@juicesharp\rpiv-config\index.ts",
    "vendor\extensions\node_modules\@juicesharp\rpiv-todo\index.ts",
    "config\project-AGENTS.template.md",
    "extensions\verify-guard\index.ts",
    "vendor\extensions\node_modules\pi-allowlist-plugin\extensions\allowlist-gate\index.ts", "config\extensions\allowlist-gate.json")
foreach ($item in $required) {
    $path = Join-Path $BundleRoot $item
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing bundle file: $item. Use the complete offline release ZIP." }
    if ((Get-Item -LiteralPath $path).Length -lt 1024 -and $item.EndsWith('.exe')) {
        throw "Invalid executable: $item. Replace it with the official Windows executable."
    }
}
if ($Check) {
    Write-Host "Required files found: $BundleRoot"
    return
}

function Find-VisualStudioMSBuild {
    param([string[]]$ProgramRoots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles))
    $roots = @($ProgramRoots | Where-Object { $_ } | Select-Object -Unique)
    foreach ($root in $roots) {
        $vswhere = Join-Path $root 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
            # Includes Build Tools and custom installation folders; does not download anything.
            $found = @(& $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe')
            if ($LASTEXITCODE -eq 0) {
                foreach ($candidate in $found) {
                    $candidate = $candidate.Trim()
                    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                        return (Get-Item -LiteralPath $candidate).FullName
                    }
                }
            }
        }
    }
    # Older/offline installations may not have vswhere. Search only the usual VS layout.
    $candidates = @(foreach ($root in $roots) {
        Get-ChildItem -Path (Join-Path $root 'Microsoft Visual Studio\*\*\MSBuild\*\Bin\MSBuild.exe') -File -ErrorAction SilentlyContinue
    })
    $latest = $candidates | Sort-Object -Property @{ Expression = {
        [version]('{0}.{1}.{2}.{3}' -f $_.VersionInfo.FileMajorPart, $_.VersionInfo.FileMinorPart, $_.VersionInfo.FileBuildPart, $_.VersionInfo.FilePrivatePart)
    }; Descending = $true }, FullName | Select-Object -First 1
    if ($latest) { return $latest.FullName }
    return $null
}

# Some PCs reset user environment variables at sign-in, so everything pi needs before extensions load is machine-wide.
# The server SDK (runtime\dotnet) stays off PATH so project builds keep the developer's own SDK.
$pathDirs = { param($root) @('bin', 'bin\pi', 'bin\svn\bin', 'bin\redis', 'runtime\python', 'vendor\extensions\node_modules\@ast-grep\cli') | ForEach-Object { Join-Path $root $_ } }
# pi reads every setting from PI_CODING_AGENT_DIR: settings.json, models.json, AGENTS.md, extensions\subagent\config.json.
$configDir = Join-Path $BundleRoot 'config'
$machineVars = @{ PI_CODING_AGENT_DIR = $configDir; HSC_PI_HARNESS_HOME = $BundleRoot; PI_OFFLINE = '1'; PI_TELEMETRY = '0'; PI_SKIP_VERSION_CHECK = '1' }
$systemPathDirs = @(& $pathDirs $BundleRoot)
$msbuildExe = Find-VisualStudioMSBuild
if ($msbuildExe) {
    $machineVars['HSC_MSBUILD_EXE'] = $msbuildExe
    $systemPathDirs += Split-Path -Parent $msbuildExe
    Write-Host "Visual Studio MSBuild: $msbuildExe"
} else {
    Write-Host 'Visual Studio MSBuild was not found. Existing MSBuild environment settings are unchanged.'
}
$envKeyPath = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
function Get-MachinePath {
    # Raw value so entries such as %SystemRoot% stay unexpanded when written back.
    $value = [string][Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($envKeyPath).GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    @($value.Split(';') | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
}
function Test-SystemReady {
    $machinePath = @(Get-MachinePath)
    $expected = $systemPathDirs
    for ($i = 0; $i -lt $expected.Count; $i++) {
        if ($machinePath.Count -le $i -or $machinePath[$i] -ne $expected[$i]) { return $false }
        if (@($machinePath | Where-Object { $_ -eq $expected[$i] }).Count -ne 1) { return $false }
    }
    $wrongVars = @($machineVars.Keys | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Machine') -ne $machineVars[$_] })
    return ($wrongVars.Count -eq 0)
}
$previousHome = [Environment]::GetEnvironmentVariable('HSC_PI_HARNESS_HOME', 'Machine')

$models = Join-Path $configDir 'models.json'
$legacyModels = Join-Path $BundleRoot 'models.json'
if (-not (Test-Path -LiteralPath $models) -and (Test-Path -LiteralPath $legacyModels)) {
    # Earlier releases kept models.json in the bundle root.
    Copy-Item -LiteralPath $legacyModels -Destination $models
    Write-Host "Copied models.json to $models"
}
if (-not (Test-Path -LiteralPath $models)) {
    throw "Copy config\models.example.json to config\models.json and set your internal API URL/model, then run setup again."
}
Get-Content -LiteralPath $models -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null

if (-not (Test-SystemReady)) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        $envKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($envKeyPath, $true)
        try {
            $remove = $systemPathDirs + @(if ($previousHome) { & $pathDirs $previousHome })
            $kept = @(([string]$envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')).Split(';') |
                Where-Object { $_ -and $remove -notcontains $_.TrimEnd('\') })
            # Bundled fd/rg/SVN/Redis must take precedence over older copies already on PATH.
            $envKey.SetValue('Path', (($systemPathDirs + $kept) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        } finally { $envKey.Close() }
        # Setting variables through .NET broadcasts the change so newly opened terminals see the new values.
        foreach ($name in $machineVars.Keys) { [Environment]::SetEnvironmentVariable($name, $machineVars[$name], 'Machine') }
    } elseif ($SystemOnly) {
        throw "Administrator rights are required to update system environment variables."
    } else {
        Write-Host "Requesting administrator rights to update system environment variables..."
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -Wait `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-SystemOnly')
    }
    if (-not (Test-SystemReady)) { throw "System environment variables were not updated (administrator rights required)." }
}
if ($SystemOnly) { return }

# Optional Redis features start with empty local mappings; never overwrite internal data on reruns.
foreach ($file in @('server_IP_mappings.json', 'owners.json')) {
    $mapping = Join-Path $configDir (Join-Path 'redis' $file)
    if (-not (Test-Path -LiteralPath $mapping)) { [IO.File]::WriteAllText($mapping, "{}", $utf8) }
}

# Old releases stored PI_CODING_AGENT_DIR=<bundle>\agent in HKCU. User variables override
# machine variables in a fresh Windows environment, even when Test-SystemReady succeeds.
# Run in the original caller's account after successful setup, including when UAC uses another account.
foreach ($name in $machineVars.Keys) {
    if ($null -ne [Environment]::GetEnvironmentVariable($name, 'User')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'User')
        if ($null -ne [Environment]::GetEnvironmentVariable($name, 'User')) {
            throw "Could not remove conflicting user environment variable: $name"
        }
        Write-Host "Removed obsolete user override: $name"
    }
    [Environment]::SetEnvironmentVariable($name, $machineVars[$name], 'Process')
}
Write-Host "System PATH: $($systemPathDirs -join ', ')"
Write-Host "pi settings: $configDir"
Write-Host "Setup complete. Fully close your terminal application, reopen it, and run 'pi' in any folder."
