#!/usr/bin/env bash
# Apply every migration to a throwaway Postgres cluster and run every *checks.sql.
#
# Usage: supabase/tests/run_sql_checks.sh [cluster_dir]
#   cluster_dir defaults to a fresh mktemp directory and is deleted afterwards.
#   PG_BIN (default /opt/homebrew/bin) and PG_PORT (default 55432) override.
#
# The cluster is a bare Postgres with supabase/tests/stubs.sql standing in for
# the Supabase bootstrap, so this checks migration SQL and RPC behavior, not
# Supabase platform services.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
pg_bin="${PG_BIN:-/opt/homebrew/bin}"
port="${PG_PORT:-55432}"
dir="${1:-$(mktemp -d)}"
data="$dir/data"
# Unix socket paths are capped near 104 bytes, so the socket gets its own
# short temp directory instead of living under a possibly long cluster_dir.
sock="$(mktemp -d)"

rm -rf "$data"
"$pg_bin/initdb" -D "$data" -U postgres --auth=trust >/dev/null
"$pg_bin/pg_ctl" -D "$data" -o "-p $port -k $sock -c listen_addresses=''" -l "$dir/pg.log" -w start >/dev/null
trap '"$pg_bin/pg_ctl" -D "$data" -m fast -w stop >/dev/null; rm -rf "$sock"; [ -n "${1:-}" ] || rm -rf "$dir"' EXIT

psql_run() {
  "$pg_bin/psql" -X -q -h "$sock" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
}

psql_run -f "$here/stubs.sql"
for f in "$migrations"/*.sql; do
  echo "applying $(basename "$f")"
  psql_run -f "$f"
done
for c in "$here"/*checks.sql; do
  psql_run -o /dev/null -f "$c"
done
echo "all SQL checks passed"
