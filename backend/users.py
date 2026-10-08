"""Persönliche Zugangscodes: einzeln anlegen und sperren, ohne das Hauptpasswort zu teilen."""
import hmac
import json
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .config import env

_lock = threading.Lock()


@dataclass(frozen=True)
class User:
    name: str
    admin: bool = False


def data_dir() -> Path:
    path = Path(env("DATA_DIR", "data"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _file() -> Path:
    return data_dir() / "users.json"


def _load() -> list[dict]:
    try:
        return json.loads(_file().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []


def _save(users: list[dict]) -> None:
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(users, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(_file())


def list_users() -> list[dict]:
    return _load()


def create_user(name: str) -> dict:
    user = {"id": secrets.token_hex(4), "name": name.strip()[:40], "code": secrets.token_urlsafe(9), "created": int(time.time())}
    with _lock:
        _save(_load() + [user])
    return user


def delete_user(user_id: str) -> bool:
    with _lock:
        users = _load()
        kept = [u for u in users if u["id"] != user_id]
        if len(kept) == len(users):
            return False
        _save(kept)
        return True


def authenticate(token: str) -> User | None:
    """Hauptpasswort ergibt Admin, ein gültiger Zugangscode einen normalen Nutzer."""
    if not token:
        return None
    admin_pw = env("APP_PASSWORD")
    if admin_pw and hmac.compare_digest(token, admin_pw):
        return User("Admin", True)
    for u in _load():
        if hmac.compare_digest(token, u["code"]):
            return User(u["name"])
    return None
