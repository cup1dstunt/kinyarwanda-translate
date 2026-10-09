"""Vokabellisten: gemeinsam für alle angemeldeten Personen sichtbar, löschen darf Besitzer oder Admin."""
import json
import secrets
import threading
import time

from .users import data_dir

CATEGORIES = ["Alltag", "Essen & Einkaufen", "Reisen & Unterwegs", "Gesundheit", "Familie & Freunde", "Sonstiges"]
MAX_ITEMS = 200
MAX_LISTS = 100
_lock = threading.Lock()


def _file():
    return data_dir() / "lists.json"


def _load() -> list[dict]:
    try:
        return json.loads(_file().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []


def _save(lists: list[dict]) -> None:
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(lists, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(_file())


def all_lists() -> list[dict]:
    return _load()


def add(owner: str, title: str, source: str, target: str, items: list[dict], category: str = "Sonstiges") -> dict:
    entry = {"id": secrets.token_hex(4), "owner": owner, "title": title.strip()[:60], "source": source,
             "target": target, "items": items, "category": category, "created": int(time.time())}
    with _lock:
        lists = _load()
        if len(lists) >= MAX_LISTS:
            raise ValueError("Zu viele Listen")
        _save(lists + [entry])
    return entry


def delete(list_id: str, owner: str, admin: bool) -> bool | None:
    """True = gelöscht, False = nicht gefunden, None = keine Berechtigung."""
    with _lock:
        lists = _load()
        found = next((x for x in lists if x["id"] == list_id), None)
        if found is None:
            return False
        if not admin and found["owner"] != owner:
            return None
        _save([x for x in lists if x["id"] != list_id])
        return True


def add_items(list_id: str, owner: str, admin: bool, items: list[dict]) -> dict | bool | None:
    """Wörter an eine eigene Liste anhängen (doppelte Wörter werden übersprungen).

    Rückgabe: die Liste, False = nicht gefunden, None = keine Berechtigung; ValueError bei zu vielen Wörtern.
    """
    with _lock:
        lists = _load()
        found = next((x for x in lists if x["id"] == list_id), None)
        if found is None:
            return False
        if not admin and found["owner"] != owner:
            return None
        known = {i["a"].casefold() for i in found["items"]}
        new = [i for i in items if i["a"].casefold() not in known]
        if len(found["items"]) + len(new) > MAX_ITEMS:
            raise ValueError("Liste ist voll")
        found["items"] += new
        _save(lists)
        return found
