#!/usr/bin/env python3
"""Print the next free ASC build number for the fork t3code app (max+1).

Fail-soft: exit 1 on any error. The relay chain (EAS Workflows) shares this
ASC app and consumes build numbers too, so never trust a static value.
"""
import json
import os
import sys
import time
import urllib.request

KEY_ID = os.environ.get("ASC_KEY_ID", "L5B22BWV65")
ISSUER = os.environ.get("ASC_ISSUER_ID", "9530561c-e298-4fd3-8996-83ac712300bb")
KEY_PATH = os.environ.get(
    "ASC_KEY_PATH",
    os.path.expanduser("~/.appstoreconnect/private_keys/AuthKey_L5B22BWV65.p8"),
)
APP_ID = os.environ.get("ASC_APP_ID", "6831013532")


def b64u(b: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jwt() -> str:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    key = serialization.load_pem_private_key(open(KEY_PATH, "rb").read(), password=None)
    header = b64u(json.dumps({"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}).encode())
    payload = b64u(
        json.dumps({"iss": ISSUER, "exp": int(time.time()) + 600, "aud": "appstoreconnect-v1"}).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    return f"{header}.{payload}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


req = urllib.request.Request(
    f"https://api.appstoreconnect.apple.com/v1/builds?filter%5Bapp%5D={APP_ID}&limit=20&sort=-uploadedDate",
    headers={"Authorization": f"Bearer {jwt()}"},
)
with urllib.request.urlopen(req, timeout=20) as resp:
    data = json.load(resp)
versions = []
for build in data.get("data", []):
    try:
        versions.append(int(build["attributes"]["version"]))
    except (KeyError, ValueError):
        pass
if not versions:
    sys.exit(1)
print(max(versions) + 1)
