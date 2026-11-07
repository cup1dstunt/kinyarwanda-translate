"""Eigene Phrasen pro Person (Wörterbuch-Ergänzung), gespeichert in /data/phrases_user.json."""
import json
import secrets
import threading

from .users import data_dir

MAX_PER_USER = 500
_lock = threading.Lock()


def _file():
    return data_dir() / "phrases_user.json"


def _load() -> dict[str, list[dict]]:
    try:
        return json.loads(_file().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def _save(data: dict) -> None:
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(_file())


def mine(owner: str) -> list[dict]:
    return _load().get(owner, [])


def add_many(owner: str, entries: list[dict]) -> list[dict]:
    """Hängt Phrasen an; wer schon dieselbe deutsche Fassung hat, wird übersprungen."""
    with _lock:
        data = _load()
        own = data.get(owner, [])
        known = {p["de"].casefold() for p in own}
        fresh = []
        for e in entries:
            if e["de"].casefold() in known:
                continue
            known.add(e["de"].casefold())
            fresh.append({"id": secrets.token_hex(4), **e})
        if len(own) + len(fresh) > MAX_PER_USER:
            raise ValueError("Zu viele eigene Phrasen")
        data[owner] = own + fresh
        _save(data)
        return fresh


def delete(owner: str, phrase_id: str) -> bool:
    with _lock:
        data = _load()
        own = data.get(owner, [])
        if not any(p["id"] == phrase_id for p in own):
            return False
        data[owner] = [p for p in own if p["id"] != phrase_id]
        _save(data)
        return True
