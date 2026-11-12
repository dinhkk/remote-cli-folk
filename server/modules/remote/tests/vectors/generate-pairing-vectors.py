#!/usr/bin/env python3
"""Independent reference for the pairing-ceremony vectors (contracts section 5, ceremony invariants).

Standard library only (hmac/hashlib, hand-written HKDF-SHA256), so the vectors do not depend on
Node's crypto. The inputs reuse the fixed ECDH secret and nonces of derivation.json; the public
keys are arbitrary fixed bytes because the SAS, the commitment and the confirmations only hash
or MAC them.

    commitment C  = HMAC-SHA256(key = Nh, pkH || pkC)
    transcript h  = SHA256(pkC || pkH || Nc || Nh)
    SAS           = decimal(uint32_be(h[0:4]) mod 10^6), zero padded to 6 digits
    K             = HKDF(ECDH, salt = Nc || Nh, info "pairing-key")
    macKey        = HKDF(K, info "mac")
    confirmation  = HMAC-SHA256(macKey, "remotecli/v1/pair-confirm-<role>" || h)

Run: python generate-pairing-vectors.py > pairing.json
"""
import hashlib
import hmac
import json

PREFIX = "remotecli/v1/"


def hkdf(ikm: bytes, info: str, length: int, salt: bytes = b"") -> bytes:
    prk = hmac.new(salt or b"\x00" * 32, ikm, hashlib.sha256).digest()
    okm, block = b"", b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(prk, block + (PREFIX + info).encode() + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


PK_C = bytes(range(0x60, 0x80))
PK_H = bytes(range(0x80, 0xA0))
ECDH = bytes(range(0x20, 0x40))
NONCE_C = bytes(range(0x40, 0x50))
NONCE_H = bytes(range(0x50, 0x60))

commitment = hmac.new(NONCE_H, PK_H + PK_C, hashlib.sha256).digest()
transcript = hashlib.sha256(PK_C + PK_H + NONCE_C + NONCE_H).digest()
sas = "%06d" % (int.from_bytes(transcript[:4], "big") % 1_000_000)
k = hkdf(ECDH, "pairing-key", 32, NONCE_C + NONCE_H)
mac_key = hkdf(k, "mac", 32)


def confirmation(role: str) -> str:
    return hmac.new(mac_key, (PREFIX + "pair-confirm-" + role).encode() + transcript, hashlib.sha256).hexdigest()


print(
    json.dumps(
        {
            "pkCHex": PK_C.hex(),
            "pkHHex": PK_H.hex(),
            "ecdhHex": ECDH.hex(),
            "nonceCHex": NONCE_C.hex(),
            "nonceHHex": NONCE_H.hex(),
            "commitmentHex": commitment.hex(),
            "transcriptHex": transcript.hex(),
            "sas": sas,
            "pairingKeyHex": k.hex(),
            "hostConfirmHex": confirmation("host"),
            "controllerConfirmHex": confirmation("controller"),
        },
        indent=2,
    )
)
