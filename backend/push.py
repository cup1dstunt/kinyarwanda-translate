"""Push-Mitteilungen (Web Push, RFC 8030/8291/8292) für neue Chat-Nachrichten.

Jedes Gerät meldet eine Adresse bei Apple/Google/Mozilla an; der Server schickt dorthin eine
verschlüsselte Mitteilung. Schlüssel erzeugen: `python -m backend.push` (Ausgabe in .env eintragen).
"""
import base64
import json
import threading
import time
from urllib.parse import urlparse

import http_ece
import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02

from .config import env
from .users import data_dir

# Nur die Push-Dienste der Browser-Hersteller, sonst könnte man den Server beliebige Adressen aufrufen lassen
ALLOWED_HOSTS = ("fcm.googleapis.com", "push.apple.com", "push.services.mozilla.com", "notify.windows.com")
MAX_PER_USER = 10
TTL_SECONDS = 24 * 3600

_lock = threading.Lock()


class PushError(Exception):
    pass


def public_key() -> str:
    return env("VAPID_PUBLIC_KEY")


def enabled() -> bool:
    return bool(public_key() and env("VAPID_PRIVATE_KEY"))


def _b64decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _file():
    return data_dir() / "push.json"


def _load() -> list[dict]:
    try:
        return json.loads(_file().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []


def _save(subs: list[dict]) -> None:
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(subs, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(_file())


def subscribe(name: str, endpoint: str, p256dh: str, auth: str) -> None:
    url = urlparse(endpoint)
    host = url.hostname or ""
    if url.scheme != "https" or not any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS):
        raise PushError("Unbekannter Push-Dienst")
    try:
        if len(_b64decode(p256dh)) != 65 or len(_b64decode(auth)) != 16:
            raise ValueError
    except ValueError:
        raise PushError("Ungültige Anmeldung für Mitteilungen")
    with _lock:
        # ein Gerät gehört immer nur einer Person (z. B. nach Wechsel des Zugangscodes)
        subs = [s for s in _load() if s["endpoint"] != endpoint]
        mine = [s for s in subs if s["name"] == name]
        if len(mine) >= MAX_PER_USER:  # älteste Geräte zuerst ersetzen
            oldest = min(mine, key=lambda s: s["created"])
            subs.remove(oldest)
        subs.append({"name": name, "endpoint": endpoint, "p256dh": p256dh, "auth": auth, "created": int(time.time())})
        _save(subs)


def unsubscribe(name: str, endpoint: str) -> None:
    with _lock:
        _save([s for s in _load() if not (s["endpoint"] == endpoint and s["name"] == name)])


def has_devices(name: str) -> bool:
    return any(s["name"] == name for s in _load())


def encrypt(sub: dict, payload: bytes) -> bytes:
    """Nachricht für genau dieses Gerät verschlüsseln (aes128gcm, RFC 8291)."""
    server_key = ec.generate_private_key(ec.SECP256R1())
    return http_ece.encrypt(payload, private_key=server_key, dh=_b64decode(sub["p256dh"]),
                            auth_secret=_b64decode(sub["auth"]), version="aes128gcm")


def _vapid_headers(endpoint: str) -> dict:
    url = urlparse(endpoint)
    claims = {"sub": env("VAPID_SUBJECT", "mailto:admin@example.com"), "aud": f"{url.scheme}://{url.netloc}",
              "exp": int(time.time()) + 12 * 3600}
    return Vapid02.from_string(env("VAPID_PRIVATE_KEY")).sign(claims)


def _deliver(sub: dict, payload: bytes, client: httpx.Client) -> int:
    headers = {**_vapid_headers(sub["endpoint"]), "TTL": str(TTL_SECONDS), "Urgency": "high",
               "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream"}
    return client.post(sub["endpoint"], content=encrypt(sub, payload), headers=headers, timeout=10).status_code


def send(name: str, message: dict) -> int:
    """An alle Geräte einer Person schicken. Abgemeldete Geräte (404/410) werden entfernt. Gibt die Zahl der Zustellungen zurück."""
    if not enabled():
        return 0
    subs = [s for s in _load() if s["name"] == name]
    payload = json.dumps(message, ensure_ascii=False).encode()
    gone, sent = [], 0
    with httpx.Client() as client:
        for sub in subs:
            try:
                status = _deliver(sub, payload, client)
            except httpx.HTTPError:
                continue
            if status in (404, 410):
                gone.append(sub["endpoint"])
            elif status < 300:
                sent += 1
    if gone:
        with _lock:
            _save([s for s in _load() if s["endpoint"] not in gone])
    return sent


def generate_keys() -> tuple[str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    private = _b64encode(key.private_numbers().private_value.to_bytes(32, "big"))
    public = _b64encode(key.public_key().public_bytes(serialization.Encoding.X962,
                                                      serialization.PublicFormat.UncompressedPoint))
    return public, private


if __name__ == "__main__":
    pub, priv = generate_keys()
    print(f"VAPID_PUBLIC_KEY={pub}\nVAPID_PRIVATE_KEY={priv}\nVAPID_SUBJECT=mailto:deine@adresse.de")
