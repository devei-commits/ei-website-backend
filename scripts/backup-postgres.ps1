# Full Postgres backup via Docker container orders_postgres.
# Writes SQL + custom-format files under ei-website-backend/backups/
param(
  [string]$ContainerName = "orders_postgres"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backupDir = Join-Path $root "backups"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$user = (docker exec $ContainerName printenv POSTGRES_USER 2>$null | Select-Object -First 1).Trim()
$db = (docker exec $ContainerName printenv POSTGRES_DB 2>$null | Select-Object -First 1).Trim()
if (-not $user -or -not $db) {
  throw "Could not read POSTGRES_USER / POSTGRES_DB from container '$ContainerName'. Is it running?"
}

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$sqlHost = Join-Path $backupDir "ei_pg_backup_$ts.sql"
$dumpHost = Join-Path $backupDir "ei_pg_backup_$ts.dump"

Write-Host "Backing up $db as $user from $ContainerName ..."

docker exec $ContainerName pg_dump -U $user -d $db --no-owner --no-acl -f /tmp/backup.sql
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker exec $ContainerName pg_dump -U $user -d $db --no-owner --no-acl -Fc -f /tmp/backup.dump
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

docker cp "${ContainerName}:/tmp/backup.sql" $sqlHost
docker cp "${ContainerName}:/tmp/backup.dump" $dumpHost
docker exec $ContainerName rm -f /tmp/backup.sql /tmp/backup.dump

Get-Item $sqlHost, $dumpHost | Format-Table Name, Length, LastWriteTime
Write-Host "Done. Restore instructions: backups/RESTORE.md"
