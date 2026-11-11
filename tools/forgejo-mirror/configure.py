#!/usr/bin/env python3
"""Create a Forgejo pull mirror or request its next sync. Never deletes a repo."""
import argparse
import json
import os
import sys
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["create", "sync", "status"])
    args = parser.parse_args()
    token = os.environ.get("FORGEJO_TOKEN", "")
    if not token:
        raise ValueError("FORGEJO_TOKEN is required")
    root = "https://code.ai17z.io/api/v1"
    path = "/repos/AI17Z/ai17z"
    method, data = "GET", None
    if args.action == "create":
        # The old repository has to be archived/deleted by the operator first.
        path, method = "/repos/migrate", "POST"
        data = dict(clone_addr="https://github.com/ShiftAboveCtrl/ai17z.git", repo_owner="AI17Z", repo_name="ai17z", mirror=True, mirror_interval="10m0s", private=False, service="git", releases=False, issues=False, pull_requests=False, wiki=False)
    elif args.action == "sync":
        path, method = path + "/mirror-sync", "POST"
    payload = json.dumps(data).encode() if data else None
    # Cloudflare in front of the forge answers 403 (error 1010) to a request with no User-Agent.
    headers = {"Authorization": "token " + token, "Content-Type": "application/json", "User-Agent": "AI17Z-mirror-config"}
    request = Request(root + path, data=payload, method=method, headers=headers)
    with urlopen(request, timeout=120) as response:
        body = response.read()
        result = json.loads(body) if body else {}
    if args.action == "create":
        request = Request(root + "/repos/AI17Z/ai17z", data=b'{"has_actions":false}', method="PATCH", headers=headers)
        with urlopen(request, timeout=120):
            pass
    if args.action == "status":
        print(json.dumps({name: result.get(name) for name in ("mirror", "mirror_interval", "mirror_updated", "has_actions")}))
    else:
        print("Pull mirror " + args.action + " requested")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Mirror operation refused ({type(error).__name__}); no repository was deleted", file=sys.stderr)
        sys.exit(1)
