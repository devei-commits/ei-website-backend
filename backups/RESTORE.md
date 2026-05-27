# Postgres backup & restore (EI backend)

Backups are full database dumps of the Postgres DB used by `ei-website-backend` (Sequelize / `DATABASE_URL`).

Each run creates **two** files in this folder:

| File | Format | Use |
|------|--------|-----|
| `ei_pg_backup_YYYYMMDD_HHMMSS.sql` | Plain SQL | Human-readable; restore with `psql` |
| `ei_pg_backup_YYYYMMDD_HHMMSS.dump` | PostgreSQL custom (`pg_restore`) | **Preferred for restore** — smaller, faster |

---

## Create a backup (current data)

From `ei-website-backend`, with Docker DB running (`orders_postgres`):

```bash
cd /path/to/ei-website-backend
docker compose up -d db
chmod +x scripts/backup-postgres.sh
./scripts/backup-postgres.sh
```

Or via npm:

```bash
npm run db:backup
```

**Windows (PowerShell):**

```powershell
.\scripts\backup-postgres.ps1
```

**Different container name:**

```bash
POSTGRES_CONTAINER=your_container_name ./scripts/backup-postgres.sh
```

---

## Restore a backup

**Warning:** Restore **drops** the target database and replaces all data. Stop the API first to avoid open connections.

```bash
cd /path/to/ei-website-backend
docker compose stop app   # optional but recommended
./scripts/restore-postgres.sh backups/ei_pg_backup_YYYYMMDD_HHMMSS.dump
```

Type `YES` when prompted, or pass `--force` to skip confirmation:

```bash
./scripts/restore-postgres.sh backups/ei_pg_backup_YYYYMMDD_HHMMSS.dump --force
```

Restore from `.sql` instead:

```bash
./scripts/restore-postgres.sh backups/ei_pg_backup_YYYYMMDD_HHMMSS.sql --force
```

Then start services again:

```bash
docker compose up -d
```

**npm:**

```bash
npm run db:restore -- backups/ei_pg_backup_YYYYMMDD_HHMMSS.dump --force
```

**Windows (PowerShell):**

```powershell
.\scripts\restore-postgres.ps1 -BackupPath backups\ei_pg_backup_YYYYMMDD_HHMMSS.dump -Force
```

Default container: `orders_postgres` (override with `POSTGRES_CONTAINER=...` on restore script).

---

## Restore without project scripts (manual)

Custom format (`.dump`):

```bash
docker cp backups/ei_pg_backup_....dump orders_postgres:/tmp/restore.dump
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" orders_postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --clean --if-exists /tmp/restore.dump
```

Plain SQL (empty DB first):

```bash
docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" orders_postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < backups/ei_pg_backup_....sql
```

Use credentials from `ei-website-backend/.env` (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).

---

## Notes

- Backups include **all** tables (orders, planning, procurement, warehouse, users, etc.).
- Keep `.dump` files out of git if they contain production secrets (add to `.gitignore` if needed).
- For a **copy** of data on another machine: copy the `.dump` file, run the same Postgres major version (16), and use `restore-postgres.sh` there.
