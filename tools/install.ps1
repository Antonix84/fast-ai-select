#requires -Version 5.1
<#
.SYNOPSIS
    Installs or removes Fast AI Select as an external UXP plugin for Photoshop.

.DESCRIPTION
    Copies plugin/ to %APPDATA%\Adobe\UXP\Plugins\External and registers it in
    PS.json. No files outside the user's UXP folder are touched.

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

function Read-PluginInfo {
    if (Test-Path $infoPath) {
        try {
            return Get-Content $infoPath -Raw | ConvertFrom-Json
        }
        catch {
            Write-Warning "Could not parse $infoPath; it will be recreated."
        }
    }
    return [pscustomobject]@{ plugins = @() }
}

function Write-PluginInfo($info) {
    $dir = Split-Path -Parent $infoPath
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $json = $info | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($infoPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-ExistingPlugins($info) {
    if ($info -and $info.PSObject.Properties.Name -contains 'plugins') {
        return @($info.plugins | Where-Object { $_ -and $_.pluginId })
    }
    return @()
}

if ($Uninstall) {
    $removed = 0
    if (Test-Path $externalRoot) {
        Get-ChildItem $externalRoot -Directory -Filter "${pluginId}_*" -ErrorAction SilentlyContinue |
            ForEach-Object {
                Remove-Item $_.FullName -Recurse -Force
                Write-Host "Removed $($_.FullName)"
                $removed++
            }
    }
    $info = Read-PluginInfo
    $remaining = @(Get-ExistingPlugins $info | Where-Object { $_.pluginId -ne $pluginId })
    Write-PluginInfo ([pscustomobject]@{ plugins = $remaining })
    if ($removed -eq 0) { Write-Host "No installed Fast AI Select folder was found." }
    Write-Host "$pluginName uninstalled."
    exit 0
}

if (-not $Force -and (Get-Process Photoshop -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Warning "Photoshop is running. Close it and run the installer again."
    Write-Warning "Replacing the files of a plugin that is currently loaded makes it disappear"
    Write-Warning "from the Plugins menu until Photoshop restarts."
    Write-Warning "To install anyway: tools\install.ps1 -Force"
    exit 1
}

# Remove older versions of this plugin before copying the new one.
if (Test-Path $externalRoot) {
    Get-ChildItem $externalRoot -Directory -Filter "${pluginId}_*" -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.FullName -ne $target) {
                Remove-Item $_.FullName -Recurse -Force
                Write-Host "Removed old version $($_.Name)"
            }
        }
}

New-Item -ItemType Directory -Path $externalRoot -Force | Out-Null
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Copy-Item $source $target -Recurse -Force

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
    'models\modnet.onnx'
)
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $target $_)) })
if ($missing.Count -gt 0) {
    throw "Installed copy is incomplete. Missing: $($missing -join ', ')"
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

$info = Read-PluginInfo
$others = @(Get-ExistingPlugins $info | Where-Object { $_.pluginId -ne $pluginId })
Write-PluginInfo ([pscustomobject]@{ plugins = @($others + $entry) })

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
Write-Host "  registration: $infoPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Make sure UXP Developer Mode is enabled."
Write-Host "  2. Restart Photoshop."
Write-Host "  3. Open Plugins > Fast AI Select."
Write-Host "  4. Run 'Выделить человека' or 'Удалить фон'."
