# Restore a .dump or .sql backup into an EMPTY database (drops DB first).
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,
  [string]$ContainerName = "orders_postgres",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupPath)) {
  throw "Backup not found: $BackupPath"
}

$user = (docker exec $ContainerName printenv POSTGRES_USER 2>$null | Select-Object -First 1).Trim()
$db = (docker exec $ContainerName printenv POSTGRES_DB 2>$null | Select-Object -First 1).Trim()
if (-not $user -or -not $db) {
  throw "Could not read POSTGRES_USER / POSTGRES_DB from container '$ContainerName'."
}

if (-not $Force) {
  Write-Warning "This will DROP database '$db' and restore from $BackupPath"
  $confirm = Read-Host "Type YES to continue"
  if ($confirm -ne "YES") { Write-Host "Aborted."; exit 0 }
}

$ext = [System.IO.Path]::GetExtension($BackupPath).ToLowerInvariant()

Write-Host "Dropping and recreating database $db ..."
docker exec $ContainerName psql -U $user -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS `"$db`" WITH (FORCE);"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker exec $ContainerName psql -U $user -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE `"$db`" OWNER `"$user`";"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($ext -eq ".dump") {
  $remote = "/tmp/restore.dump"
  docker cp $BackupPath "${ContainerName}:$remote"
  docker exec $ContainerName pg_restore -U $user -d $db --no-owner --no-acl --clean --if-exists $remote
  $code = $LASTEXITCODE
  docker exec $ContainerName rm -f $remote
  if ($code -ne 0) { exit $code }
} elseif ($ext -eq ".sql") {
  Get-Content $BackupPath -Raw | docker exec -i $ContainerName psql -U $user -d $db -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  throw "Use a .sql or .dump file (pg_dump custom format)."
}

Write-Host "Restore finished into $db on $ContainerName."
