#requires -Version 5.1
<#
.SYNOPSIS
    Installs or removes Fast AI Select as an external UXP plugin for Photoshop.

.DESCRIPTION
    Copies plugin/ to %APPDATA%\Adobe\UXP\Plugins\External and registers it in
    PS.json. The new copy is staged and verified before the working installation
    is replaced. A failed copy leaves the previous version and registration
    intact.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install.ps1
    powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Force,
    [switch]$EnableDeveloperMode,
    [string]$UxpRoot = (Join-Path $env:APPDATA 'Adobe\UXP')
)

$ErrorActionPreference = 'Stop'

$pluginId = 'com.fastaiselect.panel'
$pluginName = 'Fast AI Select'
$hostMinVersion = '26.0.0'

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'plugin'
if (-not (Test-Path (Join-Path $source 'manifest.json'))) {
    $source = Join-Path $PSScriptRoot 'plugin'
}
$manifestPath = Join-Path $source 'manifest.json'
if (-not (Test-Path $manifestPath)) {
    throw "Cannot find plugin/manifest.json. Run install.bat from the repository root."
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$pluginDirName = "${pluginId}_$version"

$externalRoot = Join-Path $UxpRoot 'Plugins\External'
$target = Join-Path $externalRoot $pluginDirName
$infoPath = Join-Path $UxpRoot 'PluginsInfo\v1\PS.json'

$required = @(
    'manifest.json',
    'index.html',
    'index.js',
    'guided_filter.js',
    'js\core.js',
    'js\engine.js',
    'js\ps.js',
    'js\wasm-env.js',
    'lib\ort.wasm.min.js',
    'lib\ort-wasm-simd.wasm',
    'lib\ort-wasm.wasm',
    'models\modnet.onnx',
    'lib\licenses\ORT-LICENSE.txt',
    'models\licenses\MODNET-LICENSE.txt',
    'models\licenses\MODNET-NOTICE.txt'
)

function Read-PluginInfo {
    if (-not (Test-Path $infoPath)) {
        return [pscustomobject]@{ plugins = @() }
    }

    try {
        $raw = [System.IO.File]::ReadAllText($infoPath)
        $info = $raw | ConvertFrom-Json
    }
    catch {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "$infoPath.corrupt-$stamp.json"
        Copy-Item $infoPath $backup -Force
        throw "Could not parse $infoPath. The damaged file was preserved at $backup. " +
              'Repair or remove it, then run the installer again.'
    }

    if ($null -eq $info -or $info -is [System.Array]) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "$infoPath.corrupt-$stamp.json"
        Copy-Item $infoPath $backup -Force
        throw "Unexpected PS.json structure. The file was preserved at $backup."
    }
    return $info
}

function Write-TextAtomic([string]$text) {
    $dir = Split-Path -Parent $infoPath
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $temp = Join-Path $dir ('.fast-ai-select-ps-' + [guid]::NewGuid().ToString('N') + '.tmp')

    try {
        [System.IO.File]::WriteAllText($temp, $text, $encoding)
        if (Test-Path $infoPath) {
            $backup = "$infoPath.fast-ai-select-bak"
            Remove-Item $backup -Force -ErrorAction SilentlyContinue
            [System.IO.File]::Replace($temp, $infoPath, $backup, $true)
            Remove-Item $backup -Force -ErrorAction SilentlyContinue
        }
        else {
            Move-Item $temp $infoPath -Force
        }
    }
    finally {
        if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
    }
}

function Write-PluginInfoAtomic($info) {
    Write-TextAtomic ($info | ConvertTo-Json -Depth 12)
}

function Get-OtherPluginEntries($info) {
    if (-not ($info.PSObject.Properties.Name -contains 'plugins')) {
        $info | Add-Member -MemberType NoteProperty -Name plugins -Value @() -Force
    }
    return @($info.plugins | Where-Object {
        -not ($_ -and ($_.PSObject.Properties.Name -contains 'pluginId') -and
            $_.pluginId -eq $pluginId)
    })
}

function Set-PluginEntry($info, $entry) {
    $others = @(Get-OtherPluginEntries $info)
    $info.plugins = @($others + $entry)
    return $info
}

function Remove-PluginEntry($info) {
    $others = @(Get-OtherPluginEntries $info)
    $info.plugins = @($others)
    return $info
}

function Assert-RequiredFiles($root) {
    $missing = @($required | Where-Object { -not (Test-Path (Join-Path $root $_)) })
    if ($missing.Count -gt 0) {
        throw "Plugin copy is incomplete. Missing: $($missing -join ', ')"
    }
}

function Assert-CopyMatchesSource($sourceRoot, $copyRoot) {
    $sourceFiles = @(Get-ChildItem $sourceRoot -Recurse -File)
    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart([char[]]@('\', '/'))
        $copy = Join-Path $copyRoot $relative
        if (-not (Test-Path $copy)) {
            throw "Staged copy is missing $relative."
        }
        $sourceHash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
        $copyHash = (Get-FileHash $copy -Algorithm SHA256).Hash
        if ($sourceHash -ne $copyHash) {
            throw "Staged copy differs from the source: $relative."
        }
    }
}

function Assert-PhotoshopClosed {
    if ($Force) { return }
    if (Get-Process Photoshop -ErrorAction SilentlyContinue) {
        Write-Host ""
        Write-Warning "Photoshop is running. Close it and run the installer again."
        Write-Warning "Replacing the files of a loaded plugin makes it disappear from the Plugins menu."
        Write-Warning "To override anyway: tools\install.ps1 -Force"
        exit 1
    }
}

if (-not (Test-Path $source)) {
    throw "Cannot find the plugin folder: $source"
}
Assert-RequiredFiles $source

if ($Uninstall) {
    Assert-PhotoshopClosed

    $info = Read-PluginInfo
    $info = Remove-PluginEntry $info

    # Move folders aside first, then update registration atomically. If the
    # registration write fails, the original folders are restored.
    $uninstallRoot = Join-Path $externalRoot ('.fast-ai-select-uninstall-' +
        [guid]::NewGuid().ToString('N'))
    $moved = @()
    if (Test-Path $externalRoot) {
        $folders = @(Get-ChildItem $externalRoot -Directory -Filter "${pluginId}_*" `
            -ErrorAction SilentlyContinue)
        if ($folders.Count -gt 0) {
            New-Item -ItemType Directory -Path $uninstallRoot -Force | Out-Null
            try {
                foreach ($folder in $folders) {
                    $destination = Join-Path $uninstallRoot $folder.Name
                    Move-Item $folder.FullName $destination
                    $moved += [pscustomobject]@{ From = $folder.FullName; To = $destination }
                }
            }
            catch {
                foreach ($item in $moved) {
                    if (Test-Path $item.To) { Move-Item $item.To $item.From }
                }
                if (Test-Path $uninstallRoot) {
                    Remove-Item $uninstallRoot -Recurse -Force -ErrorAction SilentlyContinue
                }
                throw
            }
        }
    }

    try {
        Write-PluginInfoAtomic $info
    }
    catch {
        foreach ($item in $moved) {
            if (Test-Path $item.To) { Move-Item $item.To $item.From }
        }
        if (Test-Path $uninstallRoot) { Remove-Item $uninstallRoot -Recurse -Force -ErrorAction SilentlyContinue }
        throw
    }

    foreach ($item in $moved) {
        Write-Host "Removed $($item.From)"
    }
    if (Test-Path $uninstallRoot) {
        Remove-Item $uninstallRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($moved.Count -eq 0) { Write-Host "No installed Fast AI Select folder was found." }
    Write-Host "$pluginName uninstalled."
    exit 0
}

Assert-PhotoshopClosed
Assert-RequiredFiles $source

$externalRootFull = [System.IO.Path]::GetFullPath($externalRoot)
$targetFull = [System.IO.Path]::GetFullPath($target)
if (-not $targetFull.StartsWith($externalRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to install outside the UXP external plugins folder: $targetFull"
}

New-Item -ItemType Directory -Path $externalRoot -Force | Out-Null

$stage = Join-Path $externalRoot ('.fast-ai-select-stage-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $externalRoot ('.fast-ai-select-backup-' + [guid]::NewGuid().ToString('N'))
$targetMoved = $false
$stageMoved = $false
$registrationChanged = $false
$originalInfoText = $null

try {
    Copy-Item $source $stage -Recurse -Force
    Assert-RequiredFiles $stage
    Assert-CopyMatchesSource $source $stage

    # Parse existing registration before touching the working installation.
    $info = Read-PluginInfo
    if (Test-Path $infoPath) {
        $originalInfoText = [System.IO.File]::ReadAllText($infoPath)
    }
    $entry = [pscustomobject]@{
        hostMinVersion = $hostMinVersion
        name           = $pluginName
        path           = '$localPlugins\External\' + $pluginDirName
        pluginId       = $pluginId
        status         = 'enabled'
        type           = 'uxp'
        versionString  = $version
    }
    $info = Set-PluginEntry $info $entry

    if (Test-Path $target) {
        Move-Item $target $backup
        $targetMoved = $true
    }
    Move-Item $stage $target
    $stageMoved = $true

    try {
        Write-PluginInfoAtomic $info
        $registrationChanged = $true
    }
    catch {
        # Restore the previous plugin folder; PS.json is still the old atomic
        # file because Write-PluginInfoAtomic either replaced it or did not.
        if ($stageMoved -and (Test-Path $target)) {
            Remove-Item $target -Recurse -Force
            $stageMoved = $false
        }
        if ($targetMoved -and (Test-Path $backup)) {
            Move-Item $backup $target
            $targetMoved = $false
        }
        throw
    }

    # Verify the registration after the atomic write.
    $verify = Read-PluginInfo
    $registered = @($verify.plugins | Where-Object { $_ -and $_.pluginId -eq $pluginId })
    if ($registered.Count -ne 1 -or $registered[0].status -ne 'enabled') {
        throw "Registration verification failed for $pluginId."
    }
    if ($registered[0].path -ne $entry.path) {
        throw "Registration points at an unexpected path: $($registered[0].path)"
    }

    if ($targetMoved -and (Test-Path $backup)) {
        Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
        $targetMoved = $false
    }

    # Only remove older versions after the new one is installed and registered.
    Get-ChildItem $externalRoot -Directory -Filter "${pluginId}_*" -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.FullName -ne $target) {
                Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "Removed old version $($_.Name)"
            }
        }
}
catch {
    if ($stageMoved -and (Test-Path $target)) {
        Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
        $stageMoved = $false
    }
    if ($targetMoved -and (Test-Path $backup)) {
        Move-Item $backup $target
        $targetMoved = $false
    }
    if ($registrationChanged) {
        try {
            if ($null -eq $originalInfoText) {
                if (Test-Path $infoPath) { Remove-Item $infoPath -Force }
            }
            else {
                Write-TextAtomic $originalInfoText
            }
        }
        catch {
            Write-Warning "Could not restore the previous PS.json: $($_.Exception.Message)"
        }
    }
    throw
}
finally {
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($EnableDeveloperMode) {
    $developerDir = Join-Path $env:CommonProgramFiles 'Adobe\UXP\Developer'
    $developerSettings = Join-Path $developerDir 'settings.json'
    $payload = '{"developer": true}'
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($isAdmin) {
        New-Item -ItemType Directory -Path $developerDir -Force | Out-Null
        [System.IO.File]::WriteAllText($developerSettings, $payload, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "UXP Developer Mode enabled."
    }
    else {
        Write-Warning "Enabling UXP Developer Mode needs administrator rights."
        Write-Warning "Alternatively enable it once in the UXP Developer Tool, then restart Photoshop."
    }
}

$developerSettings = Join-Path $env:CommonProgramFiles 'Adobe\UXP\Developer\settings.json'
if (-not (Test-Path $developerSettings)) {
    Write-Warning "UXP Developer Mode does not look enabled. Enable it once in the UXP Developer Tool,"
    Write-Warning "or run this installer as administrator with -EnableDeveloperMode."
}

$size = (Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ""
Write-Host "Installed $pluginName $version" -ForegroundColor Green
Write-Host ("  plugin:       {0} ({1:N1} MB)" -f $target, ($size / 1MB))
Write-Host ("  registration: {0}" -f $infoPath)
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Make sure UXP Developer Mode is enabled."
Write-Host "  2. Restart Photoshop."
Write-Host "  3. Open Plugins > Fast AI Select."
Write-Host "  4. Run 'Выделить человека' or 'Удалить фон'."
