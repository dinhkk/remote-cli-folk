#!/usr/bin/env python3
"""Independent reference for the Remote key-derivation vectors (contracts section 5).

Deliberately uses only the Python standard library (hmac/hashlib) and a hand-written
HKDF-SHA256 (RFC 5869), so the vectors do not depend on Node's crypto implementation.
The Worker (relay) tests compare against the same derivation.json.

Run: python generate-derivation-vectors.py > derivation.json
"""
import base64
import hashlib
import hmac
import json

PREFIX = "cloudcli-remote/v1/"


def hkdf(ikm: bytes, info: str, length: int, salt: bytes = b"") -> bytes:
    # RFC 5869: empty salt means a string of HashLen zero bytes.
    prk = hmac.new(salt or b"\x00" * 32, ikm, hashlib.sha256).digest()
    okm, block = b"", b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(prk, block + (PREFIX + info).encode() + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def gate(secret: str, kind: str, room: str) -> str:
    return hmac.new(secret.encode(), f"{kind}:{room}".encode(), hashlib.sha256).hexdigest()


K = bytes(range(0x00, 0x20))
ECDH = bytes(range(0x20, 0x40))
NONCE_C = bytes(range(0x40, 0x50))
NONCE_H = bytes(range(0x50, 0x60))
CODE = "ABCDEFGH"
RELAY_SECRET = "test-relay-secret"

room_id = hkdf(K, "room", 16).hex()
pair_room_id = hkdf(CODE.encode(), "pair-room", 16).hex()

vectors = {
    "link": {
        "kHex": K.hex(),
        "roomId": room_id,
        "hostToken": b64url(hkdf(K, "relay-token-host", 32)),
        "controllerToken": b64url(hkdf(K, "relay-token-controller", 32)),
        "macKeyHex": hkdf(K, "mac", 32).hex(),
    },
    "gate": {
        "relaySecret": RELAY_SECRET,
        "link": gate(RELAY_SECRET, "link", room_id),
        "pair": gate(RELAY_SECRET, "pair", pair_room_id),
    },
    "pair": {
        "normalizedCode": CODE,
        "pairRoomId": pair_room_id,
        "pairToken": b64url(hkdf(CODE.encode(), "pair-token", 32)),
    },
    "session": {
        "ecdhHex": ECDH.hex(),
        "nonceCHex": NONCE_C.hex(),
        "nonceHHex": NONCE_H.hex(),
        "keyC2HHex": hkdf(K + ECDH, "c2h", 32, NONCE_C + NONCE_H).hex(),
        "keyH2CHex": hkdf(K + ECDH, "h2c", 32, NONCE_C + NONCE_H).hex(),
        "pairingKeyHex": hkdf(ECDH, "pairing-key", 32, NONCE_C + NONCE_H).hex(),
    },
}
print(json.dumps(vectors, indent=2))
