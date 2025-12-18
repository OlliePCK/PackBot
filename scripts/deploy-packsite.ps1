param(
  [string]$ConfigPath = "$PSScriptRoot\deploy.config.json",
  [switch]$CleanRemote,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Read-DeployConfig([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing config file: $Path. Create it from scripts\deploy.config.example.json"
  }
  $raw = Get-Content -LiteralPath $Path -Raw
  return $raw | ConvertFrom-Json
}

$cfg = Read-DeployConfig -Path $ConfigPath

if (-not $cfg.host) { throw "Config missing 'host'" }
if (-not $cfg.user) { throw "Config missing 'user'" }
if (-not $cfg.targetPath) { throw "Config missing 'targetPath'" }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
$packsiteDir = Join-Path $repoRoot "PackSite"
if (-not (Test-Path -LiteralPath $packsiteDir)) {
  $packsiteDir = Join-Path $repoRoot "packsite"
}
if (-not (Test-Path -LiteralPath $packsiteDir)) {
  throw "PackSite directory not found at '$($repoRoot.Path)\\PackSite' or '$($repoRoot.Path)\\packsite'"
}

Write-Host "Preparing PackSite for deployment (Vite build -> static nginx)..." -ForegroundColor Cyan

if (-not $SkipBuild) {
  Write-Host "Building PackSite..." -ForegroundColor Cyan
  Push-Location $packsiteDir
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $packsiteDir "node_modules"))) {
      Write-Host "Installing dependencies..." -ForegroundColor Cyan
      & npm ci
    }
    & npm run build
  } finally {
    Pop-Location
  }
} else {
  Write-Host "Skipping build (requested)." -ForegroundColor Yellow
}

$distDir = Join-Path $packsiteDir "dist"
if (-not (Test-Path -LiteralPath $distDir)) {
  throw "Missing build output at '$distDir'. Run 'npm run build' in PackSite, or omit -SkipBuild."
}

$deployItems = @(Get-ChildItem -LiteralPath $distDir -Force | ForEach-Object { $_.Name })

# Files that Vite does NOT bundle/copy (referenced as absolute /... in HTML)
$extraRootItems = @(
  "api.js",
  "sw.js",
  "manifest.json",
  "img"
)

$dest = "$($cfg.user)@$($cfg.host):$($cfg.targetPath.TrimEnd('/'))/"

$sshArgs = @()
if ($cfg.identityFile) {
  $sshArgs += "-i"
  $sshArgs += $cfg.identityFile
}
if ($cfg.port) {
  $sshArgs += "-p"
  $sshArgs += [string]$cfg.port
}

$remote = "$($cfg.user)@$($cfg.host)"
$remotePath = $cfg.targetPath.TrimEnd('/')

Write-Host "Ensuring remote target exists: $remotePath" -ForegroundColor Cyan
& ssh @sshArgs $remote "mkdir -p '$remotePath'"

$scpArgs = @()
if ($cfg.identityFile) {
  $scpArgs += "-i"
  $scpArgs += $cfg.identityFile
}

if ($cfg.port) {
  $scpArgs += "-P"
  $scpArgs += [string]$cfg.port
}

$scpArgs += "-r"

if ($CleanRemote) {
  Write-Host "Cleaning remote target: $remotePath" -ForegroundColor Yellow
  & ssh @sshArgs $remote "rm -rf '$remotePath'/*"
}

Write-Host "Uploading files to $dest" -ForegroundColor Cyan
foreach ($item in $deployItems) {
  $itemPath = Join-Path $distDir $item
  if (Test-Path -LiteralPath $itemPath) {
    Write-Host "  Uploading $item..." -ForegroundColor Gray
    & scp @scpArgs $itemPath $dest
  } else {
    Write-Host "  Skipping $item (not found)" -ForegroundColor Yellow
  }
}

foreach ($item in $extraRootItems) {
  $itemPath = Join-Path $packsiteDir $item
  if (Test-Path -LiteralPath $itemPath) {
    Write-Host "  Uploading $item..." -ForegroundColor Gray
    & scp @scpArgs $itemPath $dest
  } else {
    Write-Host "  Skipping $item (not found)" -ForegroundColor Yellow
  }
}

Write-Host "Fixing permissions..." -ForegroundColor Cyan
& ssh @sshArgs $remote "chown -R nobody:users '$remotePath' && chmod -R 755 '$remotePath' && find '$remotePath' -type f -exec chmod 644 {} +"

Write-Host "PackSite deployed." -ForegroundColor Green
