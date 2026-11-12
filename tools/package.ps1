#requires -Version 5.1
<#
.SYNOPSIS
    Builds the distributable Fast AI Select archives.

.DESCRIPTION
    Creates:
      dist/FastAISelect-<version>.zip         full package (plugin + installer + docs)
      dist/FastAISelect-<version>-plugin.zip  bare plugin folder (manifest at root)
      dist/SHA256SUMS.txt                     checksums

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\package.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $repoRoot 'plugin'
$distDir = Join-Path $repoRoot 'dist'

$manifestPath = Join-Path $pluginDir 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "Cannot find plugin/manifest.json" }

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$name = "FastAISelect-$version"

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
    'lib\licenses\ORT-LICENSE.txt',
    'models\modnet.onnx',
    'models\licenses\MODNET-LICENSE.txt',
    'models\licenses\MODNET-NOTICE.txt'
)
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $pluginDir $_)) })
if ($missing.Count -gt 0) {
    throw "Plugin folder is incomplete. Missing: $($missing -join ', ')"
}

if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

$stage = Join-Path $distDir $name
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Copy-Item $pluginDir (Join-Path $stage 'plugin') -Recurse -Force
Copy-Item (Join-Path $repoRoot 'tools') (Join-Path $stage 'tools') -Recurse -Force
foreach ($file in @('install.bat', 'uninstall.bat', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
    $path = Join-Path $repoRoot $file
    if (Test-Path $path) { Copy-Item $path $stage -Force }
}

# Keep only distribution-safe tools in the package.
$keepTools = @('install.ps1', 'fetch-deps.ps1', 'patch-ort.js', 'verify-offline.ps1')
$stageTools = Join-Path $stage 'tools'
Get-ChildItem $stageTools -File | Where-Object {
    $_.Name -notin $keepTools
} | Remove-Item -Force

$fullZip = Join-Path $distDir "$name.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $fullZip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$pluginZip = Join-Path $distDir "$name-plugin.zip"
Compress-Archive -Path (Join-Path $pluginDir '*') -DestinationPath $pluginZip -CompressionLevel Optimal

$sums = Get-ChildItem $distDir -File -Filter '*.zip' | Sort-Object Name | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    "$hash  $($_.Name)"
}
$sumsPath = Join-Path $distDir 'SHA256SUMS.txt'
[System.IO.File]::WriteAllLines($sumsPath, $sums, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Get-ChildItem $distDir -File | ForEach-Object {
    Write-Host ("{0,-42} {1,12:N1} MB" -f $_.Name, ($_.Length / 1MB))
}
Write-Host ""
Write-Host "Package ready: $distDir" -ForegroundColor Green
