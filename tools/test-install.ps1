#requires -Version 5.1
<#
.SYNOPSIS
    Integration test for tools/install.ps1 in an isolated temporary UXP root.
#>
[CmdletBinding()]
param(
    [string]$WorkRoot = (Join-Path $env:TEMP ('fast-ai-select-install-test-' +
        [guid]::NewGuid().ToString('N')))
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $PSScriptRoot 'install.ps1'
$pluginId = 'com.fastaiselect.panel'
$failures = 0
$checks = 0

function Check($name, [bool]$condition, $detail) {
    $script:checks++
    if ($condition) {
        Write-Host "  ok   $name"
    }
    else {
        $script:failures++
        Write-Host "  FAIL $name" -ForegroundColor Red
        if ($detail) { Write-Host "       $detail" }
    }
}

function Section($name) {
    Write-Host ""
    Write-Host $name -ForegroundColor Cyan
}

New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
$infoDir = Join-Path $WorkRoot 'PluginsInfo\v1'
$external = Join-Path $WorkRoot 'Plugins\External'
New-Item -ItemType Directory -Path $infoDir -Force | Out-Null
New-Item -ItemType Directory -Path $external -Force | Out-Null
$infoPath = Join-Path $infoDir 'PS.json'
$otherPath = Join-Path $external 'com.example.other_1.0.0'
New-Item -ItemType Directory -Path $otherPath -Force | Out-Null

$initial = [ordered]@{
    schemaVersion = 3
    plugins = @(
        [ordered]@{
            pluginId = 'com.example.other'
            name = 'Other Plugin'
            path = '$localPlugins\External\com.example.other_1.0.0'
            status = 'enabled'
        }
    )
}
[System.IO.File]::WriteAllText(
    $infoPath,
    ($initial | ConvertTo-Json -Depth 10),
    (New-Object System.Text.UTF8Encoding($false))
)

try {
    Section 'fresh install and registration'
    & $installer -UxpRoot $WorkRoot -Force
    Check 'installer exits successfully' ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)

    $manifest = Get-Content (Join-Path $repoRoot 'plugin\manifest.json') -Raw | ConvertFrom-Json
    $target = Join-Path $external ($pluginId + '_' + $manifest.version)
    Check 'target plugin folder exists' (Test-Path $target)
    Check 'manifest copied' (Test-Path (Join-Path $target 'manifest.json'))
    Check 'model copied' (Test-Path (Join-Path $target 'models\modnet.onnx'))

    $info = Get-Content $infoPath -Raw | ConvertFrom-Json
    $ours = @($info.plugins | Where-Object { $_.pluginId -eq $pluginId })
    $other = @($info.plugins | Where-Object { $_.pluginId -eq 'com.example.other' })
    Check 'our plugin registered exactly once' ($ours.Count -eq 1) "count $($ours.Count)"
    Check 'other plugin registration preserved' ($other.Count -eq 1)
    Check 'unrelated root JSON fields preserved' ($info.schemaVersion -eq 3) ([string]$info.schemaVersion)
    Check 'registration is enabled' ($ours.Count -eq 1 -and $ours[0].status -eq 'enabled')
    Check 'registration path points at the installed folder' (
        $ours.Count -eq 1 -and
        $ours[0].path -eq ('$localPlugins\External\' + $pluginId + '_' + $manifest.version))

    Section 'corrupt PS.json is preserved and install is aborted'
    $targetManifest = Join-Path $target 'manifest.json'
    $beforeHash = (Get-FileHash $targetManifest -Algorithm SHA256).Hash
    [System.IO.File]::WriteAllText($infoPath, '{ this is not json', (New-Object System.Text.UTF8Encoding($false)))
    $threw = $false
    try {
        & $installer -UxpRoot $WorkRoot -Force
    }
    catch {
        $threw = $true
    }
    Check 'installer rejects corrupt PS.json' $threw
    Check 'installed plugin remains untouched' (Test-Path $targetManifest)
    Check 'installed plugin content is unchanged' (
        (Test-Path $targetManifest) -and
        (Get-FileHash $targetManifest -Algorithm SHA256).Hash -eq $beforeHash)
    Check 'corrupt PS.json backup was created' (
        @(Get-ChildItem $infoDir -Filter 'PS.json.corrupt-*.json').Count -ge 1)

    Section 'uninstall preserves unrelated registration'
    $valid = [ordered]@{
        schemaVersion = 3
        plugins = @(
            [ordered]@{
                pluginId = 'com.example.other'
                name = 'Other Plugin'
                path = '$localPlugins\External\com.example.other_1.0.0'
                status = 'enabled'
            },
            [ordered]@{
                pluginId = $pluginId
                name = 'Fast AI Select'
                path = '$localPlugins\External\' + $pluginId + '_' + $manifest.version
                status = 'enabled'
                versionString = [string]$manifest.version
            }
        )
    }
    [System.IO.File]::WriteAllText(
        $infoPath,
        ($valid | ConvertTo-Json -Depth 10),
        (New-Object System.Text.UTF8Encoding($false))
    )
    & $installer -UxpRoot $WorkRoot -Uninstall -Force
    Check 'uninstall exits successfully' ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)
    Check 'plugin folder removed' (-not (Test-Path $target))
    Check 'other plugin folder remains' (Test-Path $otherPath)

    $after = Get-Content $infoPath -Raw | ConvertFrom-Json
    Check 'our registration removed' (
        @($after.plugins | Where-Object { $_.pluginId -eq $pluginId }).Count -eq 0)
    Check 'other registration remains' (
        @($after.plugins | Where-Object { $_.pluginId -eq 'com.example.other' }).Count -eq 1)
    Check 'root JSON fields survive uninstall' ($after.schemaVersion -eq 3)
}
finally {
    Remove-Item $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($failures -gt 0) {
    Write-Host "$failures of $checks install check(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "all $checks install checks passed" -ForegroundColor Green
