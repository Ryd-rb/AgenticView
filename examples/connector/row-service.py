"""Generic stdin-JSON to HTTP adapter. No database or third-party packages.

Configure a fixed process profile with kind=query/edit/history,
input=json-stdin, output=json. Set AV_TABLE_SERVICE_URL and optional
AV_TABLE_SERVICE_TOKEN privately on the connector machine. The service owns
pagination, row persistence, version checks and history.
"""
import json
import os
import sys
import urllib.request

payload = json.load(sys.stdin)
headers = {"Content-Type": "application/json", "Accept": "application/json"}
token = os.environ.get("AV_TABLE_SERVICE_TOKEN")
if token:
    headers["Authorization"] = "Bearer " + token
request = urllib.request.Request(
    os.environ["AV_TABLE_SERVICE_URL"],
    data=json.dumps(payload).encode("utf-8"),
    headers=headers,
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    body = response.read(262145)
if len(body) > 262144:
    raise ValueError("Service must return a bounded page or acknowledgement")
result = json.loads(body)
if not isinstance(result, dict):
    raise ValueError("Service must return one JSON object")
json.dump(result, sys.stdout)
