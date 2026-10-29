import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("session_inventory", Path(__file__).resolve().parents[1] / "scripts/inspect-session-inventory.py")
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class SessionInventoryContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agenticview-session-inventory-")
        self.database = Path(self.temporary.name) / "controls.sqlite"
        self.connection = sqlite3.connect(self.database)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY,target TEXT,payload TEXT)")
        self.connection.commit()

    def tearDown(self):
        self.connection.close()
        target = Path(self.temporary.name).resolve()
        self.assertEqual(target.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(target.name.startswith("agenticview-session-inventory-"))
        self.temporary.cleanup()

    def add(self, state="paused", desired="paused", lease=0, suffix="one"):
        self.connection.execute("INSERT INTO sessions VALUES(?,?,?)", (suffix, "PRIVATE_TARGET", json.dumps({
            "runId": "card-" + suffix, "state": state, "desiredState": desired,
            "leaseUntil": lease, "prompt": "PRIVATE_PROMPT", "runToken": "PRIVATE_TOKEN",
            "claimToken": "PRIVATE_CLAIM", "nativeSessionId": "PRIVATE_NATIVE_ID"})))
        self.connection.commit()

    def test_idle_inventory_omits_private_payload(self):
        self.add()
        result = inventory.inspect(self.database, 100)
        self.assertFalse(result["busy"])
        self.assertEqual(result["count"], 1)
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_active_state_or_desire_or_lease_blocks_update(self):
        cases = [("running", "paused", 0), ("paused", "running", 0), ("paused", "paused", 101),
                 ("queued", "paused", 0), ("recovering", "paused", 0), ("starting", "paused", 0)]
        for index, (state, desired, lease) in enumerate(cases):
            with self.subTest(state=state, desired=desired, lease=lease):
                self.add(state, desired, lease, str(index))
                self.assertTrue(inventory.inspect(self.database, 100)["busy"])
                self.connection.execute("DELETE FROM sessions")
                self.connection.commit()

    def test_wal_claim_is_seen_even_without_checkpoint(self):
        self.add("running", "running", 200)
        self.assertTrue(Path(str(self.database) + "-wal").exists())
        self.assertTrue(inventory.inspect(self.database, 100)["busy"])

    def test_archived_cards_do_not_hide_session_records(self):
        self.add("running", "running", 200, "archived-session")
        self.assertEqual(inventory.inspect(self.database, 100)["sessions"][0]["id"], "archived-session")
        self.assertTrue(inventory.inspect(self.database, 100)["busy"])

    def test_unknown_states_and_excess_records_fail_closed(self):
        self.add("unrecognized")
        with self.assertRaises(ValueError):
            inventory.inspect(self.database, 100)
        self.connection.execute("DELETE FROM sessions")
        payload = json.dumps({"runId": "card", "state": "draft", "desiredState": "paused", "leaseUntil": 0})
        self.connection.executemany("INSERT INTO sessions VALUES(?,?,?)", [(str(i), "target", payload) for i in range(1001)])
        self.connection.commit()
        with self.assertRaises(ValueError):
            inventory.inspect(self.database, 100)

    def test_inspection_cannot_modify_database(self):
        self.add()
        before = self.connection.execute("SELECT * FROM sessions").fetchall()
        inventory.inspect(self.database, 100)
        self.assertEqual(self.connection.execute("SELECT * FROM sessions").fetchall(), before)


if __name__ == "__main__":
    unittest.main()
