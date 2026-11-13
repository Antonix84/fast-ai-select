#requires -Version 5.1
<#
.SYNOPSIS
    Verifies that plugin/ is complete and fully offline.

.DESCRIPTION
    Checks required files, hashes, the patched WebAssembly bootstrap, the
    manifest permissions and the absence of network calls in plugin code.
    Exits with code 1 if any check fails.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\verify-offline.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $repoRoot 'plugin'
$failures = New-Object System.Collections.Generic.List[string]

function Pass($text) { Write-Host "  ok   $text" -ForegroundColor Green }
function Fail($text) { $script:failures.Add($text); Write-Host "  FAIL $text" -ForegroundColor Red }
function Section($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }

function Check-True([bool]$condition, [string]$passText, [string]$failText) {
    if ($condition) { Pass $passText } else { Fail $failText }
}

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

Section "Required files"
foreach ($relative in $required) {
    $path = Join-Path $pluginDir $relative
    Check-True (Test-Path $path) $relative "missing: $relative"
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "Aborting: required files are missing." -ForegroundColor Red
    exit 1
}

Section "Hashes"
$expected = @{
    'lib/ort-wasm-simd.wasm' = '6783FCD6647CE1B426A527C31412A9C40894552FAA609E9C931B3239A3438071'
    'lib/ort-wasm.wasm'      = '969AFD00C79AFEAD28A90B6ACD01BD64ABE4B5AC8BC9650C3DEE3AEFC6E0CEA6'
    'lib/ort.wasm.min.js'    = '80886BF285DC477EC682C5F4798E105EE014AB84EBA3F219FC7FF81BC5B5EB16'
    'models/modnet.onnx'     = '07C308CF0FC7E6E8B2065A12ED7FC07E1DE8FEBB7DC7839D7B7F15DD66584DF9'
}
foreach ($relative in $expected.Keys) {
    $path = Join-Path $pluginDir $relative
    $hash = (Get-FileHash $path -Algorithm SHA256).Hash
    Check-True ($hash -eq $expected[$relative]) "$relative hash" "hash mismatch: $relative"
}

Section "WebAssembly bootstrap"
$ort = Get-Content (Join-Path $pluginDir 'lib\ort.wasm.min.js') -Raw
$instantiateCount = ([regex]::Matches($ort, '__fasWasmInstantiate')).Count
$nativeCount = ([regex]::Matches($ort, 'WebAssembly\.instantiate')).Count
$streamingCount = ([regex]::Matches($ort, 'instantiateStreaming')).Count
Check-True ($instantiateCount -eq 4) "4 instantiate calls redirected" "unexpected __fasWasmInstantiate count: $instantiateCount"
Check-True ($nativeCount -eq 0) "no direct WebAssembly.instantiate calls" "found $nativeCount direct instantiate calls"
Check-True ($streamingCount -eq 0) "no instantiateStreaming calls" "found $streamingCount streaming calls"

$wasmEnv = Get-Content (Join-Path $pluginDir 'js\wasm-env.js') -Raw
Check-True ($wasmEnv -match 'new NativeModule') "synchronous module compilation present" "wasm-env.js does not compile modules synchronously"
Check-True ($wasmEnv -match 'global\.fetch = fetchShim') "fetch shim installed" "fetch shim missing"

Section "Manifest"
$manifest = Get-Content (Join-Path $pluginDir 'manifest.json') -Raw | ConvertFrom-Json
Check-True ($manifest.manifestVersion -eq 5) "manifest v5" "unexpected manifest version"
Check-True ($manifest.id -eq 'com.fastaiselect.panel') "plugin id" "unexpected plugin id"
Check-True ([string]$manifest.host.app -eq 'PS') "Photoshop host" "host is not PS"
Check-True (-not ($manifest.PSObject.Properties.Name -contains 'requiredPermissions')) "no permissions requested" "requiredPermissions must stay empty (offline plugin)"

$indexSource = Get-Content (Join-Path $pluginDir 'index.js') -Raw
$versionMatch = [regex]::Match($indexSource, "var VERSION = '([^']+)'")
Check-True ($versionMatch.Success -and $versionMatch.Groups[1].Value -eq [string]$manifest.version) `
    "index.js version matches manifest" "index.js and manifest versions differ"

$panelIds = @($manifest.entrypoints | Where-Object { $_.type -eq 'panel' } | ForEach-Object { $_.id })
$commandIds = @($manifest.entrypoints | Where-Object { $_.type -eq 'command' } | ForEach-Object { $_.id })
Check-True ($panelIds.Count -eq 0) "no panel entrypoint (commands only)" "panel entrypoint must be removed"
Check-True ($commandIds.Count -eq 2) "exactly two commands" "expected 2 commands, found $($commandIds.Count)"
Check-True ($commandIds -contains 'selectPerson') "command 'selectPerson'" "command 'selectPerson' missing"
Check-True ($commandIds -contains 'removeBackground') "command 'removeBackground'" "command 'removeBackground' missing"

Section "Command implementation"
$psSource = Get-Content (Join-Path $pluginDir 'js\ps.js') -Raw
Check-True ($psSource -match "KIND_PIXEL\s*=\s*1") "numeric layer kind (pixel = 1)" "layer kind constants changed"
Check-True ($psSource -match "pixel:\s*1") "string layer kinds mapped" "string layer kind mapping missing"
Check-True ($psSource -match "_obj:\s*'inverse'") "inverse selection via batchPlay" "selection inverse missing"
Check-True ($psSource -match "putLayerMask") "layer mask path present" "putLayerMask path missing"
Check-True ($psSource -match "_obj:\s*'delete'") "clear pixels via batchPlay" "pixel delete missing"
Check-True (-not ($psSource -match 'doc\.selection')) "no unsupported Document.selection API" "uses Document.selection, which PS 2025 lacks"
Check-True (-not ($psSource -cmatch 'layer\.clear\s*\(')) "no unsupported Layer.clear API" "uses Layer.clear, which PS 2025 lacks"
Check-True ($psSource -match 'assertActiveDocument') "writes re-check the active document" "active document check missing"
Check-True ($psSource -match 'colorProfile: SRGB_PROFILE') "pixels requested in sRGB" "sRGB pixel request missing"
Check-True ($psSource -match 'request\.layerID') "cut reads the target layer" "target layer read missing"

$engineSource = Get-Content (Join-Path $pluginDir 'js\engine.js') -Raw
Check-True ($engineSource -match 'targetLong !== 768') `
    "768 mode is accepted" "768 mode is not accepted"
Check-True ($engineSource -match 'invalidateSession') "hung ORT session can be invalidated" "session invalidation missing"

$coreSource = Get-Content (Join-Path $pluginDir 'js\core.js') -Raw
Check-True ($coreSource -match 'contentWidth') "letterbox content rectangle present" "letterbox layout missing"
Check-True ($coreSource -match 'makeWeightedRanges') "fractional area resize present" "area resize missing"

Section "Installer file list"
$installer = Get-Content (Join-Path $repoRoot 'tools\install.ps1') -Raw
$listMatch = [regex]::Match($installer, '(?s)\$required\s*=\s*@\((.*?)\)')
if ($listMatch.Success) {
    $installerFiles = @([regex]::Matches($listMatch.Groups[1].Value, "'([^']+)'") |
        ForEach-Object { $_.Groups[1].Value })
    $stale = @($installerFiles | Where-Object { -not (Test-Path (Join-Path $pluginDir $_)) })
    Check-True ($stale.Count -eq 0) "installer list matches plugin files" `
        "installer references missing files: $($stale -join ', ')"
}
else {
    Fail "cannot read the installer file list"
}

Section "Installer safety"
$installerSource = Get-Content (Join-Path $repoRoot 'tools\install.ps1') -Raw
Check-True ($installerSource -match 'fast-ai-select-stage') "install is staged before replacement" "staging directory missing"
Check-True ($installerSource -match 'Assert-CopyMatchesSource') "staged copy is hash-verified" "copy verification missing"
Check-True ($installerSource -match 'File\]::Replace') "PS.json is replaced atomically" "atomic PS.json write missing"
Check-True ($installerSource -match 'corrupt-') "damaged PS.json is preserved" "corrupt PS.json preservation missing"

Section "Edge refinement"
$guideSource = Get-Content (Join-Path $pluginDir 'guided_filter.js') -Raw
Check-True ($guideSource -match 'radiusFull\s*/\s*subsample') "radius scaled to the coarse grid" "guided filter radius is not scaled by subsample"
Check-True ($guideSource -match 'sharpen') "matte sharpening present" "matte sharpening missing"
Check-True ($guideSource -match 'respectSourceAlpha') "source alpha mode is explicit" "source alpha mode missing"
Check-True (-not ($guideSource -match 'pairInside|rowMax')) "no unsafe block classification shortcuts" "unsafe guided-filter shortcuts remain"

Section "Offline network scan"
$sourceFiles = @(
    'index.html', 'index.js', 'guided_filter.js',
    'js\core.js', 'js\engine.js', 'js\ps.js', 'js\wasm-env.js'
)
$networkPatterns = @('http://', 'https://', 'ws://', 'wss://', 'XMLHttpRequest', 'WebSocket', 'sendBeacon')
$found = $false
foreach ($relative in $sourceFiles) {
    $path = Join-Path $pluginDir $relative
    $text = Get-Content $path -Raw
    foreach ($pattern in $networkPatterns) {
        if ($text.Contains($pattern)) {
            Fail "$relative contains $pattern"
            $found = $true
        }
    }
}
if (-not $found) { Pass "no network API or URL in plugin sources" }

Section "JavaScript syntax"
$nodeFiles = @(
    'index.js', 'guided_filter.js',
    'js\core.js', 'js\engine.js', 'js\ps.js', 'js\wasm-env.js'
)
foreach ($relative in $nodeFiles) {
    $path = Join-Path $pluginDir $relative
    & node --check $path 2>$null
    Check-True ($LASTEXITCODE -eq 0) "$relative parses" "$relative has a syntax error"
}

Section "Size"
$libSize = (Get-ChildItem (Join-Path $pluginDir 'lib') -File | Measure-Object Length -Sum).Sum
$modelSize = (Get-Item (Join-Path $pluginDir 'models\modnet.onnx')).Length
$totalSize = (Get-ChildItem $pluginDir -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("  lib/   {0,8:N1} MB" -f ($libSize / 1MB))
Write-Host ("  model  {0,8:N1} MB" -f ($modelSize / 1MB))
Write-Host ("  total  {0,8:N1} MB" -f ($totalSize / 1MB))

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host ("{0} check(s) failed." -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host "Plugin is complete and offline-ready." -ForegroundColor Green
