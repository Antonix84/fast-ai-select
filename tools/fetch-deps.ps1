#requires -Version 5.1
<#
.SYNOPSIS
    Downloads the ONNX Runtime Web build and the MODNet model used by
    Fast AI Select, verifies them, and stages everything into plugin/.

.DESCRIPTION
    The repository already ships the staged files, so this script is only
    needed to refresh or rebuild them. It runs online; the installed plugin
    does not use the network at all.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\fetch-deps.ps1
    powershell -ExecutionPolicy Bypass -File tools\fetch-deps.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [string]$WorkDir = (Join-Path $env:TEMP 'fast-ai-select-deps')
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $repoRoot 'plugin'
$libDir = Join-Path $pluginDir 'lib'
$modelsDir = Join-Path $pluginDir 'models'

$ortVersion = '1.17.3'
$ortUrl = "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-$ortVersion.tgz"
$modelUrl = 'https://huggingface.co/TheEeeeLin/HivisionIDPhotos_matting/resolve/main/modnet_photographic_portrait_matting.onnx'

# SHA-256 of the exact files this project was built and tested against.
$expected = @{
    'lib/ort-wasm-simd.wasm' = '6783FCD6647CE1B426A527C31412A9C40894552FAA609E9C931B3239A3438071'
    'lib/ort-wasm.wasm'      = '969AFD00C79AFEAD28A90B6ACD01BD64ABE4B5AC8BC9650C3DEE3AEFC6E0CEA6'
    'lib/ort.wasm.min.js'    = '80886BF285DC477EC682C5F4798E105EE014AB84EBA3F219FC7FF81BC5B5EB16'
    'models/modnet.onnx'     = '07C308CF0FC7E6E8B2065A12ED7FC07E1DE8FEBB7DC7839D7B7F15DD66584DF9'
}

function Write-Step($text) {
    Write-Host ""
    Write-Host "== $text" -ForegroundColor Cyan
}

function Get-RemoteFile([string]$url, [string]$destination) {
    if ((Test-Path $destination) -and -not $Force) {
        Write-Host "   cached: $destination"
        return
    }
    $partial = "$destination.part"
    if (Test-Path $partial) { Remove-Item $partial -Force }
    Write-Host "   GET $url"
    & curl.exe -L --fail --retry 3 --retry-delay 2 --connect-timeout 30 -o $partial $url
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $partial) { Remove-Item $partial -Force }
        throw "curl failed with exit code $LASTEXITCODE for $url"
    }
    Move-Item -Force $partial $destination
}

function Assert-Hash([string]$relativePath, [string]$expectedHash) {
    $full = Join-Path $pluginDir $relativePath
    if (-not (Test-Path $full)) { throw "Missing file: $full" }
    $hash = (Get-FileHash $full -Algorithm SHA256).Hash
    $size = (Get-Item $full).Length
    if ($hash -ne $expectedHash) {
        throw "Hash mismatch for $relativePath`n  expected $expectedHash`n  actual   $hash"
    }
    Write-Host ("   ok {0,-28} {1,10:N0} bytes" -f $relativePath, $size)
}

foreach ($command in @('curl.exe', 'tar.exe', 'node')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command not found on PATH: $command"
    }
}

New-Item -ItemType Directory -Path $libDir -Force | Out-Null
New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

Write-Step "ONNX Runtime Web $ortVersion"
$archive = Join-Path $WorkDir "onnxruntime-web-$ortVersion.tgz"
Get-RemoteFile $ortUrl $archive

$extract = Join-Path $WorkDir "onnxruntime-web-$ortVersion"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
New-Item -ItemType Directory -Path $extract -Force | Out-Null
& tar.exe -xzf $archive -C $extract
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }

$dist = Join-Path $extract 'package\dist'
foreach ($name in @('ort.wasm.min.js', 'ort-wasm-simd.wasm', 'ort-wasm.wasm')) {
    $source = Join-Path $dist $name
    if (-not (Test-Path $source)) { throw "Archive does not contain dist/$name" }
    Copy-Item $source (Join-Path $libDir $name) -Force
    Write-Host "   staged lib/$name"
}

$ortVersionInBundle = Select-String -Path (Join-Path $libDir 'ort.wasm.min.js') -Pattern '1\.17\.3' -SimpleMatch -Quiet
if (-not $ortVersionInBundle) {
    throw "lib/ort.wasm.min.js does not report version 1.17.3"
}

Write-Step "Patch WebAssembly instantiation (Photoshop 2025 workaround)"
& node (Join-Path $PSScriptRoot 'patch-ort.js') (Join-Path $libDir 'ort.wasm.min.js')
if ($LASTEXITCODE -ne 0) { throw "patch-ort.js failed with exit code $LASTEXITCODE" }

Write-Step "MODNet photographic portrait matting model"
$modelPath = Join-Path $modelsDir 'modnet.onnx'
Get-RemoteFile $modelUrl $modelPath

Write-Step "Verify"
foreach ($relative in $expected.Keys) {
    Assert-Hash $relative $expected[$relative]
}

$total = (Get-ChildItem $libDir, $modelsDir -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ""
Write-Host ("Dependencies ready. lib/ + models/ = {0:N1} MB" -f ($total / 1MB)) -ForegroundColor Green
