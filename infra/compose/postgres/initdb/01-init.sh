#!/bin/bash
# Runs ONCE, on first Postgres init (empty data dir). Creates one login role +
# one database per app. Passwords come from the container environment (set in
# the compose file from secrets.env). Idempotent guards let a re-run be a no-op.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'league') THEN
      CREATE ROLE league LOGIN PASSWORD '${LEAGUE_DB_PASSWORD}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tour') THEN
      CREATE ROLE tour LOGIN PASSWORD '${TOUR_DB_PASSWORD}';
    END IF;
    -- Antelytics (viewer). Guarded on a non-empty password so a fresh box that
    -- has not set ANTELYTICS_DB_PASSWORD simply skips it (no broken empty-pw role).
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'antelytics')
       AND length('${ANTELYTICS_DB_PASSWORD:-}') > 0 THEN
      CREATE ROLE antelytics LOGIN PASSWORD '${ANTELYTICS_DB_PASSWORD:-}';
    END IF;
  END
  \$\$;
SQL

# CREATE DATABASE cannot run inside the DO block; guard each with a gexec.
# antelytics is created only if its role exists (i.e. the password was set).
for db in league tour; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname = '${db}'" | grep -q 1 || \
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c \
    "CREATE DATABASE ${db} OWNER ${db}"
done

if psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tc \
     "SELECT 1 FROM pg_roles WHERE rolname = 'antelytics'" | grep -q 1; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname = 'antelytics'" | grep -q 1 || \
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c \
    "CREATE DATABASE antelytics OWNER antelytics"
fi

echo "[initdb] created league / tour (+ antelytics if set) databases + roles"
