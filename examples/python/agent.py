"""Standard-library-only synthetic integration. No external systems are queried."""
import json
import os
import secrets
import urllib.request
import uuid

endpoint = os.environ.get("AV_URL", "http://127.0.0.1:4317").rstrip("/")


def post(path, key, payload):
    request = urllib.request.Request(endpoint + path, json.dumps(payload).encode(),
                                     {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


if __name__ == "__main__":
    run = post("/api/agents/register", os.environ["AV_INGEST_KEY"], {
        "requestId": str(uuid.uuid4()), "registrationKey": secrets.token_urlsafe(32),
        "agentId": "example-python", "name": "Synthetic Python tool", "role": "Example"})
    path = "/api/agents/" + run["runId"]
    try:
        post(path + "/publish", run["runToken"], {"sequence": 1, "operations": [
            {"op": "upsert", "component": {"id": "metric", "title": "Synthetic rows", "kind": "metric", "data": {"value": 42, "unit": "rows"}}},
            {"op": "upsert", "component": {"id": "plan", "title": "Plan", "kind": "markdown", "data": {"text": "## Synthetic investigation\n- Collect evidence\n- Compare results"}}}]})
        input("Synthetic view published. Press Enter to archive. ")
    finally:
        post(path + "/archive", run["runToken"], {})
