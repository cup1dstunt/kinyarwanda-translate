"""Chats zwischen angemeldeten Personen: dauerhaft im Datenordner, Abfrage per Polling.

Jeder Chat liegt in data/chats/<id>.json, Fotos in data/chats/<id>/.
Jede Person liest in ihrer eigenen Sprache; jede Nachricht wird je Sprache nur einmal übersetzt.
"""
import base64
import binascii
import json
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import Callable

from .users import data_dir

MAX_CHATS = 100
MAX_MEMBERS = 10
MAX_MESSAGES = 500  # ältere Nachrichten (und ihre Fotos) fallen weg
MAX_IMAGE_BYTES = 3_000_000  # das Frontend verkleinert vorher auf ca. 200-400 kB
EXPIRE_SECONDS = 180 * 24 * 3600  # Chats ohne Aktivität nach einem halben Jahr löschen

_lock = threading.Lock()
_chats: dict[str, dict] = {}  # id -> Chat, beim ersten Zugriff von der Platte geladen
_loaded_from: Path | None = None  # Tests wechseln den Datenordner
_reading: dict[tuple[str, str], float] = {}  # (Chat, Person) -> letzte Abfrage; wer gerade liest, bekommt keine Mitteilung
READING_SECONDS = 15


class ChatError(Exception):
    pass


def _dir() -> Path:
    path = data_dir() / "chats"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _all() -> dict[str, dict]:
    global _loaded_from
    if _loaded_from != _dir():
        _chats.clear()
        for file in _dir().glob("*.json"):
            try:
                chat = json.loads(file.read_text(encoding="utf-8"))
                _chats[chat["id"]] = chat
            except (ValueError, KeyError):
                continue
        _loaded_from = _dir()
    now = time.time()
    for cid in [c for c, chat in _chats.items() if now - chat["touched"] > EXPIRE_SECONDS]:
        _remove(cid)
    return _chats


def _save(chat: dict) -> None:
    file = _dir() / f"{chat['id']}.json"
    tmp = file.with_suffix(".tmp")
    tmp.write_text(json.dumps(chat, ensure_ascii=False), encoding="utf-8")
    tmp.replace(file)


def _remove(chat_id: str) -> None:
    _chats.pop(chat_id, None)
    (_dir() / f"{chat_id}.json").unlink(missing_ok=True)
    shutil.rmtree(_dir() / chat_id, ignore_errors=True)


def _get(chat_id: str, name: str) -> dict:
    chat = _all().get(chat_id)
    if chat is None or name not in chat["members"]:
        raise ChatError("Chat nicht gefunden")
    return chat


def _summary(chat: dict, name: str) -> dict:
    last = chat["messages"][-1] if chat["messages"] else None
    seen = chat["members"][name].get("seen", 0)
    return {
        "id": chat["id"],
        "title": chat["title"],
        "members": [{"name": n, "lang": m.get("lang")} for n, m in chat["members"].items()],
        "last": last and {"name": last["name"], "text": last["text"][:80], "image": bool(last.get("image")),
                          "time": last["time"]},
        "unread": sum(1 for m in chat["messages"] if m["id"] > seen and m["name"] != name),
        "touched": chat["touched"],
    }


def mine(name: str) -> list[dict]:
    with _lock:
        chats = [c for c in _all().values() if name in c["members"]]
        return sorted((_summary(c, name) for c in chats), key=lambda s: -s["touched"])


def create(name: str, title: str, others: list[str]) -> dict:
    members = [name] + [n for n in dict.fromkeys(others) if n != name]
    if len(members) < 2:
        raise ChatError("Bitte mindestens eine Person auswählen")
    if len(members) > MAX_MEMBERS:
        raise ChatError("Zu viele Personen")
    with _lock:
        chats = _all()
        if len(chats) >= MAX_CHATS:
            raise ChatError("Zu viele Chats")
        chat_id = secrets.token_hex(6)
        chat = {"id": chat_id, "title": title.strip()[:40], "members": {n: {"seen": 0} for n in members},
                "messages": [], "next_id": 1, "touched": time.time()}
        chats[chat_id] = chat
        _save(chat)
        return _summary(chat, name)


def leave(chat_id: str, name: str) -> None:
    with _lock:
        chat = _get(chat_id, name)
        del chat["members"][name]
        if not chat["members"]:
            _remove(chat_id)
        else:
            _save(chat)


def _decode_jpeg(image_base64: str) -> bytes:
    try:
        data = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError):
        raise ChatError("Bild fehlt oder ist zu groß")
    if not data.startswith(b"\xff\xd8\xff") or len(data) > MAX_IMAGE_BYTES:
        raise ChatError("Bild fehlt oder ist zu groß")
    return data


def post(chat_id: str, name: str, lang: str, text: str, image_base64: str = "") -> dict:
    image = _decode_jpeg(image_base64) if image_base64 else None
    with _lock:
        chat = _get(chat_id, name)
        msg = {"id": chat["next_id"], "name": name, "lang": lang, "text": text, "tr": {}, "time": int(time.time())}
        if image is not None:
            folder = _dir() / chat_id
            folder.mkdir(exist_ok=True)
            msg["image"] = f"{msg['id']}-{secrets.token_hex(4)}.jpg"
            (folder / msg["image"]).write_bytes(image)
        chat["next_id"] += 1
        chat["messages"].append(msg)
        for old in chat["messages"][:-MAX_MESSAGES]:
            if old.get("image"):
                (_dir() / chat_id / old["image"]).unlink(missing_ok=True)
        del chat["messages"][:-MAX_MESSAGES]
        chat["members"][name]["lang"] = lang
        chat["touched"] = time.time()
        _save(chat)
        return msg


def delete_message(chat_id: str, name: str, msg_id: int) -> None:
    """Eigene Nachricht (samt Foto) löschen. Die ID wird gemerkt, damit andere Geräte sie ausblenden."""
    with _lock:
        chat = _get(chat_id, name)
        msg = next((m for m in chat["messages"] if m["id"] == msg_id), None)
        if msg is None:
            raise ChatError("Nachricht nicht gefunden")
        if msg["name"] != name:
            raise ChatError("Nur eigene Nachrichten können gelöscht werden")
        if msg.get("image"):
            (_dir() / chat_id / msg["image"]).unlink(missing_ok=True)
        chat["messages"].remove(msg)
        chat["deleted"] = (chat.get("deleted", []) + [msg_id])[-MAX_MESSAGES:]
        _save(chat)


def image_path(chat_id: str, name: str, file: str) -> Path:
    with _lock:
        chat = _get(chat_id, name)
        if not any(m.get("image") == file for m in chat["messages"]):
            raise ChatError("Bild nicht gefunden")
        return _dir() / chat_id / file


def unread_total(name: str) -> int:
    with _lock:
        return sum(_summary(c, name)["unread"] for c in _all().values() if name in c["members"])


def recipients(chat_id: str, sender: str) -> list[tuple[str, str]]:
    """(Name, Sprache) aller anderen Mitglieder, die den Chat gerade nicht offen haben."""
    now = time.time()
    with _lock:
        chat = _all().get(chat_id)
        if chat is None:
            return []
        return [(n, m.get("lang") or "de") for n, m in chat["members"].items()
                if n != sender and now - _reading.get((chat_id, n), 0) > READING_SECONDS]


def notice(chat_id: str, msg_id: int, lang: str, translate: Callable[[str, str, str], str]) -> dict | None:
    """Inhalt einer Mitteilung in der Sprache des Empfängers; die Übersetzung wird für später gemerkt."""
    with _lock:
        chat = _all().get(chat_id)
        msg = chat and next((m for m in chat["messages"] if m["id"] == msg_id), None)
        if msg is None:
            return None
        info = {"title": chat["title"], "name": msg["name"], "image": bool(msg.get("image")), "text": msg["text"],
                "source": msg["lang"], "cached": msg["tr"].get(lang)}
    text = info["text"]
    if text and info["source"] != lang:
        if info["cached"] is not None:
            text = info["cached"]
        else:
            try:
                text = translate(info["text"], info["source"], lang)
            except Exception:  # dann eben das Original
                text = info["text"]
            else:
                with _lock:
                    if msg in chat["messages"]:
                        msg["tr"][lang] = text
                        _save(chat)
    return {"title": info["title"], "name": info["name"], "image": info["image"], "text": text}


def fetch(chat_id: str, name: str, lang: str, after: int, translate: Callable[[str, str, str], str]) -> dict:
    """Neue Nachrichten in der Sprache des Lesenden. Übersetzt wird außerhalb der Sperre."""
    _reading[(chat_id, name)] = time.time()
    with _lock:
        chat = _get(chat_id, name)
        todo = [(m["id"], m["text"], m["lang"]) for m in chat["messages"]
                if m["id"] > after and m["text"] and m["lang"] != lang and lang not in m["tr"]]
    done = {}
    for msg_id, text, source in todo:
        try:
            done[msg_id] = translate(text, source, lang)
        except Exception:  # Anbieter-Fehler: Original zeigen, beim nächsten Abruf erneut versuchen
            continue
    with _lock:
        chat = _get(chat_id, name)
        out = []
        for msg in chat["messages"]:
            if msg["id"] in done:
                msg["tr"][lang] = done[msg["id"]]
            if msg["id"] <= after:
                continue
            shown = msg["text"] if msg["lang"] == lang else msg["tr"].get(lang, msg["text"])
            out.append({"id": msg["id"], "mine": msg["name"] == name, "name": msg["name"], "lang": msg["lang"],
                        "original": msg["text"], "text": shown, "image": msg.get("image"), "time": msg["time"]})
        me = chat["members"][name]
        last_id = chat["messages"][-1]["id"] if chat["messages"] else 0
        changed = bool(done) or me.get("seen", 0) < last_id or me.get("lang") != lang
        me["seen"], me["lang"] = max(me.get("seen", 0), last_id), lang
        if changed:
            _save(chat)
        return {"messages": out, "deleted": chat.get("deleted", []), "chat": _summary(chat, name)}
