"""Non-image behavioral contracts for the bounded reference provider."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "examples" / "connector" / "time-series-service.py"
spec = importlib.util.spec_from_file_location("time_series_service", SOURCE)
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


class ProviderContracts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agenticview-series-test-")
        self.stores = []

    def tearDown(self):
        for store in self.stores:
            store.close()
        self.directory.cleanup()

    def store(self, **options):
        result = provider.Store(str(Path(self.directory.name) / (str(len(self.stores)) + ".sqlite")), **options)
        self.stores.append(result)
        return result

    @staticmethod
    def points(start, count, stream="synthetic"):
        return [{"stream": stream, "sequence": i, "timestamp": i, "value": 1000 if i == 137 else -1000 if i == 8501 else i % 17} for i in range(start, start + count)]

    def test_envelope_preserves_real_first_last_and_spikes_with_a_hard_bound(self):
        store = self.store()
        for start in range(0, 10000, 4096):
            store.append({"batchId": "batch-" + str(start), "points": self.points(start, min(4096, 10000 - start))})
        for cap in (32, 33, 512, 2048):
            result = store.read_range({"from": 0, "to": 9999, "maxPoints": cap})
            points = result["series"][0]["points"]
            self.assertEqual(result["rawPoints"], 10000)
            self.assertLessEqual(len(points), cap)
            self.assertEqual((points[0]["x"], points[-1]["x"]), (0, 9999))
            self.assertIn({"x": 137, "y": 1000}, points)
            self.assertIn({"x": 8501, "y": -1000}, points)
            self.assertEqual(points, sorted(points, key=lambda point: point["x"]))
        window = store.read_range({"from": 500, "to": 510, "maxPoints": 32})
        self.assertEqual(window["rawPoints"], 11)
        self.assertTrue(all(500 <= point["x"] <= 510 for point in window["series"][0]["points"]))

    def test_exact_batch_retry_is_idempotent_and_conflicts_are_atomic(self):
        store = self.store()
        payload = {"batchId": "one", "points": self.points(0, 10)}
        self.assertFalse(store.append(payload)["replayed"])
        self.assertTrue(store.append(payload)["replayed"])
        changed = {"batchId": "one", "points": self.points(10, 10)}
        with self.assertRaises(ValueError):
            store.append(changed)
        with self.assertRaises(sqlite3.IntegrityError):
            store.append({"batchId": "other", "points": self.points(0, 10)})
        self.assertEqual(store.db.execute("SELECT count(*) FROM points").fetchone()[0], 10)
        self.assertEqual(store.db.execute("SELECT value FROM metadata WHERE key='point_count'").fetchone()[0], 10)

    def test_paging_filters_sorts_and_binds_cursor_to_its_query(self):
        store = self.store()
        store.append({"batchId": "rows", "points": self.points(0, 450, "stream-a")})
        first = store.read_rows({"limit": 200, "filter": "stream-a", "sort": [{"key": "value", "direction": "desc"}], "componentId": "grid"})
        self.assertEqual(len(first["rows"]), 200)
        self.assertLessEqual(len(first["nextCursor"]), 512)
        second = store.read_rows({"limit": 200, "filter": "stream-a", "sort": [{"key": "value", "direction": "desc"}], "cursor": first["nextCursor"]})
        self.assertEqual(len(second["rows"]), 200)
        self.assertFalse({row["sequence"] for row in first["rows"]} & {row["sequence"] for row in second["rows"]})
        with self.assertRaises(ValueError):
            store.read_rows({"limit": 200, "filter": "different", "cursor": first["nextCursor"]})
        self.assertEqual(store.read_rows({"filter": "missing"})["rows"], [])

    def test_retention_and_retry_ledger_caps_are_explicit(self):
        reject = self.store(max_points=5)
        with self.assertRaises(ValueError):
            reject.append({"batchId": "too-many", "points": self.points(0, 6)})
        self.assertEqual(reject.db.execute("SELECT count(*) FROM points").fetchone()[0], 0)
        drop = self.store(max_points=5, retention="drop-oldest", max_batches=1)
        payload = {"batchId": "retained", "points": self.points(0, 6)}
        self.assertEqual(drop.append(payload)["retainedPoints"], 5)
        self.assertEqual(drop.db.execute("SELECT min(timestamp) FROM points").fetchone()[0], 1)
        self.assertTrue(drop.append(payload)["replayed"])
        with self.assertRaises(ValueError):
            drop.append({"batchId": "new-ledger-entry", "points": self.points(10, 1)})

    def test_invalid_shapes_limits_and_nonfinite_values_fail_closed(self):
        store = self.store()
        for payload in ({"from": 2, "to": 1, "maxPoints": 32}, {"from": 0, "to": 1, "maxPoints": 31}, {"from": 0, "to": 1, "maxPoints": 2049}, {"from": 0, "to": 1, "maxPoints": 32, "sql": "not-supported"}):
            with self.assertRaises(ValueError):
                store.read_range(payload)
        for payload in ({"limit": 201}, {"limit": True}, {"sort": [{"key": "value;DROP TABLE points", "direction": "asc"}]}, {"cursor": "x" * 513}):
            with self.assertRaises(ValueError):
                store.read_rows(payload)
        for value in (float("nan"), float("inf"), True, 10 ** 1000):
            points = self.points(0, 1)
            points[0]["value"] = value
            with self.assertRaises(ValueError):
                store.append({"batchId": "invalid", "points": points})
        with self.assertRaises(ValueError):
            store.append({"batchId": "duplicate", "points": self.points(0, 1) * 2})
        with self.assertRaises(ValueError):
            json.loads('{"from":0,"from":1}', object_pairs_hook=provider.unique_object)


if __name__ == "__main__":
    unittest.main()
