param(
  [string]$HostName = "grid",
  [string]$User = "root",
  [string]$ContainerName = "packbot",
  [string]$Image = "olliepck/packbot:latest"
)

$ErrorActionPreference = "Stop"

Write-Host "Deploying PackBot to $User@$HostName (container: $ContainerName)" -ForegroundColor Cyan

ssh "$User@$HostName" "docker pull $Image; docker restart $ContainerName" 

Write-Host "Done." -ForegroundColor Green
