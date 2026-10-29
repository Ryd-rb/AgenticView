"""Read only the bounded managed-session state needed before a console update.

This is an optional deployment helper, not a server dependency. It deliberately
does not expose prompts, claims, credentials, connector targets or native output.
"""
import argparse
from contextlib import closing
import json
import sqlite3
import sys
import time
from pathlib import Path

MAX_SESSIONS = 1000
STATES = {"draft", "queued", "starting", "running", "recovering", "paused", "completed", "error", "offline"}
DESIRED = {"running", "paused", "completed"}


def inspect(database: Path, now_ms: int | None = None) -> dict:
    database = database.resolve(strict=True)
    if not database.is_file():
        raise ValueError("Session database is unavailable.")
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    # mode=ro preserves WAL visibility. immutable=1 could ignore recent claims.
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("BEGIN")
        rows = connection.execute(
            """SELECT id, json_extract(payload,'$.runId'),
            json_extract(payload,'$.state'), json_extract(payload,'$.desiredState'),
            json_extract(payload,'$.leaseUntil') FROM sessions LIMIT ?""",
            (MAX_SESSIONS + 1,),
        ).fetchall()
    if len(rows) > MAX_SESSIONS:
        raise ValueError("Session inventory exceeds the supported bound.")
    result = []
    for session_id, run_id, state, desired, lease in rows:
        if not isinstance(session_id, str) or not session_id or len(session_id) > 120:
            raise ValueError("Session identity is invalid.")
        if not isinstance(run_id, str) or not run_id or len(run_id) > 120:
            raise ValueError("Session card identity is invalid.")
        if state not in STATES or desired not in DESIRED:
            raise ValueError("Session state is unknown; inspect before updating.")
        if not isinstance(lease, int) or isinstance(lease, bool) or lease < 0:
            raise ValueError("Session lease is invalid.")
        result.append({"id": session_id, "runId": run_id, "state": state,
                       "desiredState": desired, "leaseActive": lease > now_ms})
    busy = any(row["state"] in {"queued", "starting", "running", "recovering"}
               or row["desiredState"] == "running" or row["leaseActive"] for row in result)
    return {"schemaVersion": 1, "count": len(result), "busy": busy, "sessions": result}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.database), separators=(",", ":")))
        return 0
    except (OSError, ValueError, sqlite3.Error):
        print(json.dumps({"error": "Managed-session inventory could not be verified. Update blocked; inspect private state."}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
