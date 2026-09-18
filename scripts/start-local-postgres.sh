#!/usr/bin/env bash
# Starts embedded Postgres copied under .local-bin/pgsql (used when Docker is unavailable).
# Preferred path for Jeff: docker compose up -d
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LD_LIBRARY_PATH="$ROOT/.local-bin/pgsql/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
BIN="$ROOT/.local-bin/pgsql/bin"
PGDATA="$ROOT/data/pg"
mkdir -p "$ROOT/data/logs" "$ROOT/data/sockets"
if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  "$BIN/initdb" -D "$PGDATA" -U storeforge --auth=trust --encoding=UTF8 --locale=C
fi
"$BIN/pg_ctl" -D "$PGDATA" -o "-p 5432 -k $ROOT/data/sockets" -l "$ROOT/data/logs/postgres.log" status \
  || "$BIN/pg_ctl" -D "$PGDATA" -o "-p 5432 -k $ROOT/data/sockets" -l "$ROOT/data/logs/postgres.log" start
echo "Postgres ready on 127.0.0.1:5432 (user/db storeforge, trust auth)"
