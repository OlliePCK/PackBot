param(
  [string]$ConfigPath = "$PSScriptRoot\deploy.config.json",
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

$remote = "$($cfg.user)@$($cfg.host)"
$remotePath = $cfg.targetPath.TrimEnd('/')

# Convert dist path to WSL mount path (trailing slash = sync contents only)
$wslDistPath = (& wsl -d Ubuntu -- wslpath -a ($distDir -replace '\\', '/')) + "/"

# Build SSH args for rsync -e (copy key to WSL tmp to fix NTFS 0777 permissions)
$sshCmd = "ssh -o StrictHostKeyChecking=no"
$keySetup = ""
$keyCleanup = ""
if ($cfg.identityFile) {
  $wslKeyPath = (& wsl -d Ubuntu -- wslpath -a ($cfg.identityFile -replace '\\', '/'))
  $sshCmd += " -i /tmp/.deploy_key"
  $keySetup = "cp '$wslKeyPath' /tmp/.deploy_key && chmod 600 /tmp/.deploy_key && "
  $keyCleanup = " && rm -f /tmp/.deploy_key"
}
if ($cfg.port) { $sshCmd += " -p $($cfg.port)" }

$rsyncDest = "$($remote):$remotePath/"

Write-Host "Syncing dist/ to $rsyncDest" -ForegroundColor Cyan
& wsl -d Ubuntu -- bash -c "${keySetup}rsync -avz --delete --chmod=D755,F644 --chown=nobody:users -e '${sshCmd}' '${wslDistPath}' '${rsyncDest}'${keyCleanup}"

Write-Host "PackSite deployed." -ForegroundColor Green
