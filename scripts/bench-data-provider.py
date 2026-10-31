"""Finite synthetic throughput measurement, not a one-hour soak or browser benchmark.

Creates a new owned evidence directory and retains the SQLite database/report.
No history is deleted. Run separately from card/browser profiling.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import sqlite3
import statistics
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--points", type=int, default=1_000_000)
    parser.add_argument("--budget-seconds", type=int, default=60)
    parser.add_argument("--queries", type=int, default=8)
    args = parser.parse_args()
    if not 1 <= args.points <= 1_000_000 or not 1 <= args.budget_seconds <= 60 or not 1 <= args.queries <= 20:
        raise ValueError("Use bounded point/query counts and a deadline no greater than 60 seconds")
    source = Path(__file__).resolve().parents[1] / "examples" / "connector" / "time-series-service.py"
    spec = importlib.util.spec_from_file_location("time_series_provider", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = Path(args.output).resolve() / ("series-benchmark-" + uuid.uuid4().hex)
    output.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    deadline = started + args.budget_seconds
    store = module.Store(str(output / "synthetic.sqlite"), max_points=args.points)
    store.db.set_progress_handler(lambda: int(time.perf_counter() > deadline), 10000)
    report = {"synthetic": True, "scope": "bounded local SQLite ingestion and queries; not a one-hour soak or browser/market measurement", "python": platform.python_version(), "sqlite": sqlite3.sqlite_version, "cpuCount": os.cpu_count(), "providerSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "benchmarkSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "budgetSeconds": args.budget_seconds, "database": str(output / "synthetic.sqlite")}
    accepted = 0
    try:
        for start in range(0, args.points, 4096):
            if time.perf_counter() > deadline:
                raise TimeoutError("Ingestion deadline exceeded")
            points = [{"stream": "synthetic", "sequence": i, "timestamp": i, "value": 1000 if i == 12345 else -1000 if i == 543210 else math.sin(i * .015)} for i in range(start, min(args.points, start + 4096))]
            accepted += store.append({"batchId": "batch-" + str(start), "points": points})["accepted"]
        elapsed = time.perf_counter() - started
        report.update({"ingestedPoints": accepted, "ingestionSeconds": elapsed, "pointsPerSecond": accepted / elapsed, "hourlyEquivalentPoints": accepted / elapsed * 3600})
        timings, counts = [], []
        for _ in range(args.queries):
            if time.perf_counter() > deadline:
                raise TimeoutError("Query deadline exceeded")
            before = time.perf_counter()
            result = store.read_range({"from": 0, "to": max(1, args.points - 1), "maxPoints": 512})
            timings.append((time.perf_counter() - before) * 1000)
            points = result["series"][0]["points"]
            counts.append(len(points))
            assert result["rawPoints"] == args.points and len(points) <= 512
            assert points[0]["x"] == 0 and points[-1]["x"] == args.points - 1
            if args.points > 543210:
                assert max(point["y"] for point in points) == 1000 and min(point["y"] for point in points) == -1000
        page = store.read_rows({"limit": 200})
        assert len(page["rows"]) <= 200
        report.update({"chartQueryCount": len(timings), "chartP50Ms": statistics.median(timings), "chartP95Ms": sorted(timings)[math.ceil(len(timings) * .95) - 1], "maxReturnedPoints": max(counts), "maxReturnedRows": len(page["rows"]), "ok": True})
    except Exception as error:
        report.update({"ok": False, "error": type(error).__name__ + ": " + str(error), "ingestedPoints": accepted})
    finally:
        store.db.set_progress_handler(None, 0)
        store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        store.close()
        report["elapsedSeconds"] = time.perf_counter() - started
        report["databaseBytes"] = (output / "synthetic.sqlite").stat().st_size
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(output / "report.json"), **report}))
    if not report["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
