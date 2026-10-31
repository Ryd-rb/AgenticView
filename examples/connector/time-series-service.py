"""Bounded generic SQLite time-series adapter. Database/operations are local CLI allowlists.

stdin is one JSON object; no input is interpreted as SQL, a path, URL or command.
Default retention rejects writes beyond the configured point count. Deletion is
available only with the operator's explicit --retention drop-oldest policy.
"""
import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys

MAX_TIME = 8_640_000_000_000_000
SAFE = re.compile(r"[A-Za-z0-9_.:-]{1,100}\Z")


def keys(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise ValueError("Unsupported or missing input fields")


def identifier(value):
    if not isinstance(value, str) or not SAFE.fullmatch(value) or value in ("__proto__", "prototype", "constructor"):
        raise ValueError("Invalid identifier")
    return value


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("Integer outside its bounded range")
    return value


def finite(value):
    try:
        valid = type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError("Point value must be finite")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result or key in ("__proto__", "prototype", "constructor"):
            raise ValueError("Duplicate or reserved JSON key")
        result[key] = value
    return result


class Store:
    def __init__(self, database, max_points=10_000_000, retention="reject", max_batches=1_000_000):
        integer(max_points, 1, 1_000_000_000)
        integer(max_batches, 1, 10_000_000)
        if retention not in ("reject", "drop-oldest"):
            raise ValueError("Unsupported retention policy")
        self.max_points, self.retention, self.max_batches = max_points, retention, max_batches
        if str(database).startswith(("\\\\", "//")) or str(database) == ":memory:":
            raise ValueError("Use a configured plain local database path")
        path = Path(database).absolute()
        for item in (path, *path.parents):
            if item.is_symlink() or item.exists() and getattr(os.stat(item, follow_symlinks=False), "st_file_attributes", 0) & 0x400:
                raise ValueError("Database paths cannot follow links")
        self.db = sqlite3.connect(str(path), timeout=5)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS points(stream TEXT NOT NULL, sequence INTEGER NOT NULL,
                timestamp INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(stream,sequence));
            CREATE INDEX IF NOT EXISTS points_time ON points(stream,timestamp,sequence);
            CREATE INDEX IF NOT EXISTS points_retention ON points(timestamp,stream,sequence);
            CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, digest TEXT NOT NULL, count INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
            INSERT OR IGNORE INTO metadata VALUES('point_count',0);
            INSERT OR IGNORE INTO metadata VALUES('batch_count',0);
        """)

    def close(self):
        self.db.close()

    def append(self, payload):
        keys(payload, ("batchId", "points"), ("batchId", "points"))
        batch = identifier(payload["batchId"])
        points = payload["points"]
        if not isinstance(points, list) or not 1 <= len(points) <= 4096:
            raise ValueError("Append requires 1..4096 points")
        normalized, seen = [], set()
        for point in points:
            keys(point, ("stream", "timestamp", "value", "sequence"), ("stream", "timestamp", "value", "sequence"))
            stream = identifier(point["stream"])
            sequence = integer(point["sequence"], 0, 9_007_199_254_740_991)
            timestamp = integer(point["timestamp"], 0, MAX_TIME)
            value = finite(point["value"])
            if (stream, sequence) in seen:
                raise ValueError("Duplicate point identity in batch")
            seen.add((stream, sequence))
            normalized.append((stream, sequence, timestamp, value))
        digest = hashlib.sha256(json.dumps(normalized, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            previous = self.db.execute("SELECT digest,count FROM batches WHERE id=?", (batch,)).fetchone()
            if previous:
                if previous[0] != digest:
                    raise ValueError("Batch identity was already used for a different payload")
                return {"batchId": batch, "accepted": previous[1], "replayed": True}
            count = self.db.execute("SELECT value FROM metadata WHERE key='point_count'").fetchone()[0]
            batches = self.db.execute("SELECT value FROM metadata WHERE key='batch_count'").fetchone()[0]
            if batches >= self.max_batches:
                raise ValueError("Configured exact-retry ledger limit reached; retain this database and provision a new one")
            excess = max(0, count + len(normalized) - self.max_points)
            if excess and self.retention == "reject":
                raise ValueError("Configured retention point limit reached")
            self.db.executemany("INSERT INTO points VALUES(?,?,?,?)", normalized)
            if excess:
                self.db.execute("DELETE FROM points WHERE rowid IN (SELECT rowid FROM points ORDER BY timestamp,stream,sequence LIMIT ?)", (excess,))
            self.db.execute("UPDATE metadata SET value=? WHERE key='point_count'", (count + len(normalized) - excess,))
            self.db.execute("INSERT INTO batches VALUES(?,?,?)", (batch, digest, len(normalized)))
            self.db.execute("UPDATE metadata SET value=? WHERE key='batch_count'", (batches + 1,))
        return {"batchId": batch, "accepted": len(normalized), "replayed": False, "retainedPoints": count + len(normalized) - excess}

    def read_range(self, payload, streams=("synthetic",)):
        with self.db:
            self.db.execute("BEGIN")
            return self._read_range(payload, streams)

    def _read_range(self, payload, streams):
        keys(payload, ("from", "to", "maxPoints"), ("from", "to", "maxPoints"))
        start, end = integer(payload["from"], 0, MAX_TIME), integer(payload["to"], 0, MAX_TIME)
        cap = integer(payload["maxPoints"], 32, 2048)
        if end <= start or not 1 <= len(streams) <= 12:
            raise ValueError("Use an ordered window and 1..12 configured streams")
        result, raw = [], 0
        for stream in streams:
            identifier(stream)
            params = (stream, start, end)
            count = self.db.execute("SELECT count(*) FROM points WHERE stream=? AND timestamp BETWEEN ? AND ?", params).fetchone()[0]
            raw += count
            select = "SELECT timestamp,value,sequence FROM points WHERE stream=? AND timestamp BETWEEN ? AND ?"
            if count <= cap:
                sampled = self.db.execute(select + " ORDER BY timestamp,sequence LIMIT ?", (*params, cap)).fetchall()
            else:
                first = self.db.execute(select + " ORDER BY timestamp,sequence LIMIT 1", params).fetchone()
                last = self.db.execute(select + " ORDER BY timestamp DESC,sequence DESC LIMIT 1", params).fetchone()
                sampled = [first, last]
                buckets = (cap - 2) // 2
                width = end - start + 1
                for bucket in range(buckets):
                    low = start + (bucket * width + buckets - 1) // buckets
                    high = start + ((bucket + 1) * width + buckets - 1) // buckets - 1
                    if low > high:
                        continue
                    bounded = (stream, low, high)
                    for direction in ("ASC", "DESC"):
                        point = self.db.execute(select + " ORDER BY value " + direction + ",timestamp,sequence LIMIT 1", bounded).fetchone()
                        if point is not None:
                            sampled.append(point)
                sampled = sorted(set(sampled), key=lambda point: (point[0], point[2]))
            result.append({"id": stream, "name": stream, "points": [{"x": point[0], "y": point[1]} for point in sampled]})
        return {"series": result, "rawPoints": raw}

    def read_rows(self, payload):
        keys(payload, ("limit", "filter", "sort", "cursor", "from", "to", "componentId"))
        if "componentId" in payload:
            identifier(payload["componentId"])
        limit = integer(payload.get("limit", 50), 1, 200)
        text = payload.get("filter", "")
        if not isinstance(text, str) or len(text) > 100:
            raise ValueError("Filter must be bounded text")
        sort = payload.get("sort", [{"key": "timestamp", "direction": "asc"}])
        if not isinstance(sort, list) or len(sort) != 1:
            raise ValueError("Use one provider-side sort")
        keys(sort[0], ("key", "direction"), ("key", "direction"))
        column, direction = sort[0]["key"], sort[0]["direction"]
        if column not in ("timestamp", "sequence", "value", "stream") or direction not in ("asc", "desc"):
            raise ValueError("Unsupported sort")
        start, end = integer(payload.get("from", 0), 0, MAX_TIME), integer(payload.get("to", MAX_TIME), 0, MAX_TIME)
        if end < start:
            raise ValueError("Invalid row window")
        identity = hashlib.sha256(json.dumps([text, column, direction, start, end], separators=(",", ":")).encode()).hexdigest()
        cursor = payload.get("cursor", "")
        seek, seek_params = "", []
        if cursor:
            if not isinstance(cursor, str) or len(cursor) > 512:
                raise ValueError("Invalid cursor")
            decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)), object_pairs_hook=unique_object)
            keys(decoded, ("last", "query"), ("last", "query"))
            if decoded["query"] != identity:
                raise ValueError("Cursor belongs to another query")
            last = decoded["last"]
            if not isinstance(last, list) or len(last) != 3:
                raise ValueError("Invalid cursor position")
            value, stream, sequence = last
            identifier(stream)
            integer(sequence, 0, 9_007_199_254_740_991)
            if column == "stream":
                identifier(value)
            elif column == "value":
                finite(value)
            else:
                integer(value, 0, MAX_TIME if column == "timestamp" else 9_007_199_254_740_991)
            comparison = ">" if direction == "asc" else "<"
            seek = " AND (" + column + comparison + "? OR (" + column + "=? AND (stream>? OR (stream=? AND sequence>?))))"
            seek_params = [value, value, stream, stream, sequence]
        # Only fixed allowlisted identifiers/direction enter SQL; all data stays in bound parameters.
        rows = self.db.execute("SELECT stream,timestamp,value,sequence FROM points WHERE timestamp BETWEEN ? AND ? AND (?='' OR instr(stream,?)>0)" + seek + " ORDER BY " + column + " " + direction + ",stream,sequence LIMIT ?", (start, end, text, text, *seek_params, limit + 1)).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        output = [dict(zip(("stream", "timestamp", "value", "sequence"), row)) for row in rows]
        following = base64.urlsafe_b64encode(json.dumps({"last": [output[-1][column], output[-1]["stream"], output[-1]["sequence"]], "query": identity}, separators=(",", ":")).encode()).decode().rstrip("=") if more else None
        return {"rows": output, "nextCursor": following, "hasMore": more}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--operation", choices=("append", "read_range", "read_rows"), required=True)
    parser.add_argument("--stream", action="append", default=[])
    parser.add_argument("--max-points", type=int, default=10_000_000)
    parser.add_argument("--max-batches", type=int, default=1_000_000)
    parser.add_argument("--retention", choices=("reject", "drop-oldest"), default="reject")
    args = parser.parse_args()
    raw = sys.stdin.buffer.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ValueError("Input exceeds the bounded request window")
    payload = json.loads(raw, object_pairs_hook=unique_object, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
    store = Store(args.database, args.max_points, args.retention, args.max_batches)
    try:
        result = store.append(payload) if args.operation == "append" else store.read_range(payload, args.stream or ["synthetic"]) if args.operation == "read_range" else store.read_rows(payload)
        output = json.dumps(result, separators=(",", ":"), allow_nan=False)
        if len(output.encode()) > 262144:
            raise ValueError("Reduce configured streams or point cap to fit the connector response window")
        print(output)
    finally:
        store.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, sqlite3.Error, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
