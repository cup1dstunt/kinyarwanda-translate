"""Gespräch über zwei (oder mehr) Handys: Räume liegen nur im Speicher, Abfrage per Polling."""
import secrets
import threading
import time
from typing import Callable

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # ohne verwechselbare Zeichen
MAX_ROOMS = 50
MAX_MEMBERS = 6
MAX_MESSAGES = 200
EXPIRE_SECONDS = 12 * 3600


class RoomError(Exception):
    pass


class Room:
    def __init__(self, code: str):
        self.code = code
        self.members: dict[str, dict] = {}  # cid -> {"name", "lang"}
        self.messages: list[dict] = []
        self.next_id = 1
        self.touched = time.time()
        self.lock = threading.Lock()


_rooms: dict[str, Room] = {}
_global = threading.Lock()


def _expire() -> None:
    now = time.time()
    for code in [c for c, r in _rooms.items() if now - r.touched > EXPIRE_SECONDS]:
        del _rooms[code]


def create(cid: str, name: str, lang: str) -> Room:
    with _global:
        _expire()
        if len(_rooms) >= MAX_ROOMS:
            raise RoomError("Zu viele offene Räume")
        code = "".join(secrets.choice(ALPHABET) for _ in range(5))
        while code in _rooms:
            code = "".join(secrets.choice(ALPHABET) for _ in range(5))
        room = Room(code)
        room.members[cid] = {"name": name, "lang": lang}
        _rooms[code] = room
        return room


def get(code: str) -> Room:
    with _global:
        _expire()
        room = _rooms.get(code.strip().upper())
    if room is None:
        raise RoomError("Raum nicht gefunden (oder abgelaufen)")
    return room


def join(code: str, cid: str, name: str, lang: str) -> Room:
    room = get(code)
    with room.lock:
        if cid not in room.members and len(room.members) >= MAX_MEMBERS:
            raise RoomError("Raum ist voll")
        room.members[cid] = {"name": name, "lang": lang}
        room.touched = time.time()
    return room


def leave(code: str, cid: str) -> None:
    try:
        room = get(code)
    except RoomError:
        return
    with room.lock:
        room.members.pop(cid, None)
    if not room.members:
        with _global:
            _rooms.pop(room.code, None)


def post(room: Room, cid: str, text: str) -> dict:
    with room.lock:
        member = room.members.get(cid)
        if member is None:
            raise RoomError("Du bist nicht (mehr) in diesem Raum")
        msg = {"id": room.next_id, "cid": cid, "name": member["name"], "lang": member["lang"], "text": text, "tr": {}}
        room.next_id += 1
        room.messages.append(msg)
        del room.messages[:-MAX_MESSAGES]
        room.touched = time.time()
        return msg


def fetch(room: Room, cid: str, after: int, translate: Callable[[str, str, str], str]) -> dict:
    """Neue Nachrichten in der Sprache des Abrufenden. Jede Sprache wird je Nachricht nur einmal übersetzt."""
    with room.lock:
        member = room.members.get(cid)
        if member is None:
            raise RoomError("Du bist nicht (mehr) in diesem Raum")
        room.touched = time.time()
        lang = member["lang"]
        out = []
        for msg in room.messages:
            if msg["id"] <= after:
                continue
            shown = msg["text"] if msg["lang"] == lang else msg["tr"].get(lang)
            if shown is None:
                shown = translate(msg["text"], msg["lang"], lang)
                msg["tr"][lang] = shown
            out.append({"id": msg["id"], "mine": msg["cid"] == cid, "name": msg["name"], "lang": msg["lang"],
                        "original": msg["text"], "text": shown})
        members = [{"name": m["name"], "lang": m["lang"]} for m in room.members.values()]
    return {"messages": out, "members": members}
