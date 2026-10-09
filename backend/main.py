from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import cache, currency, lists, ocr, rooms, tts, userphrases, users
from .config import env, max_input_chars
from .providers import LANGUAGES, ProviderError, available_providers

app = FastAPI(title="Übersetzer-PWA")


def require_password(x_app_password: str = Header(default="")) -> users.User:
    user = users.authenticate(x_app_password)
    if user is None:
        raise HTTPException(401, "Falsches Passwort oder Zugangscode")
    return user


def require_admin(user: users.User = Depends(require_password)) -> users.User:
    if not user.admin:
        raise HTTPException(403, "Nur für den Admin")
    return user


class NewUser(BaseModel):
    name: str


class VocabItem(BaseModel):
    a: str
    b: str = ""  # leer = automatisch übersetzen


class NewList(BaseModel):
    title: str
    source: str
    target: str
    items: list[VocabItem]
    category: str = "Sonstiges"


class MoreItems(BaseModel):
    items: list[VocabItem]


class NewPhrase(BaseModel):
    text: str
    lang: str
    category: str = "Eigene"


class PhrasesFromList(BaseModel):
    list_id: str


class RoomJoin(BaseModel):
    cid: str
    lang: str
    code: str | None = None  # leer = neuen Raum erstellen


class RoomMessage(BaseModel):
    cid: str
    text: str


class TranslateRequest(BaseModel):
    text: str
    source: str
    target: str
    provider: str | None = None


class SpeakRequest(BaseModel):
    text: str
    lang: str


class OCRRequest(BaseModel):
    image: str  # Base64 ohne "data:"-Präfix


class ConvertRequest(BaseModel):
    amount: float
    source: str
    target: str


@app.get("/health")
def health():
    return {"status": "ok", "version": env("APP_VERSION", "dev")}


@app.get("/api/providers", dependencies=[Depends(require_password)])
def providers(user: users.User = Depends(require_password)):
    names = list(available_providers())
    return {
        "me": {"name": user.name, "admin": user.admin},
        "providers": names,
        "default": names[0] if names else None,
        "languages": LANGUAGES,
        "tts": bool(tts.api_key()),
        "ocr": bool(ocr.api_key()),
    }


def translate_text(text: str, source: str, target: str, provider_name: str | None = None) -> tuple[str, str, bool]:
    """Prüft, übersetzt und nutzt den Cache. Gibt (Übersetzung, Anbieter, aus_Cache) zurück."""
    text = text.strip()
    if not text:
        raise HTTPException(400, "Kein Text")
    if len(text) > max_input_chars():
        raise HTTPException(413, f"Text zu lang (max. {max_input_chars()} Zeichen)")
    if source not in LANGUAGES or target not in LANGUAGES or source == target:
        raise HTTPException(400, "Ungültige Sprachwahl")
    providers_ = available_providers()
    if not providers_:
        raise HTTPException(503, "Kein Anbieter konfiguriert")
    name = provider_name or next(iter(providers_))
    provider = providers_.get(name)
    if provider is None:
        raise HTTPException(400, "Unbekannter Anbieter")
    cached = cache.get(name, source, target, text)
    if cached is not None:
        return cached, name, True
    try:
        translation = provider.translate(text, source, target)
    except ProviderError as exc:
        raise HTTPException(502, str(exc))
    cache.put(name, source, target, text, translation)
    return translation, name, False


@app.post("/api/translate", dependencies=[Depends(require_password)])
def translate(req: TranslateRequest):
    translation, name, cached = translate_text(req.text, req.source, req.target, req.provider)
    out = {"translation": translation, "provider": name}
    if cached:
        out["cached"] = True
    return out


@app.post("/api/tts", dependencies=[Depends(require_password)])
def speak(req: SpeakRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Kein Text")
    if len(text) > max_input_chars():
        raise HTTPException(413, f"Text zu lang (max. {max_input_chars()} Zeichen)")
    if not tts.api_key():
        raise HTTPException(503, "Kein Google-Key für die Sprachausgabe")
    try:
        return Response(tts.synthesize(text, req.lang), media_type="audio/mpeg")
    except tts.TTSError as exc:
        raise HTTPException(502, str(exc))


@app.post("/api/ocr", dependencies=[Depends(require_password)])
def recognize(req: OCRRequest):
    if not req.image or len(req.image) > ocr.MAX_IMAGE_BASE64:
        raise HTTPException(413, "Bild fehlt oder ist zu groß")
    if not ocr.api_key():
        raise HTTPException(503, "Kein Google-Key für die Texterkennung")
    try:
        text = ocr.detect_text(req.image)
    except ocr.OCRError as exc:
        raise HTTPException(502, str(exc))
    return {"text": text[: max_input_chars()]}


@app.post("/api/convert", dependencies=[Depends(require_password)])
def convert(req: ConvertRequest):
    if req.amount < 0 or req.amount > 1e12:
        raise HTTPException(400, "Ungültiger Betrag")
    try:
        return currency.convert(req.amount, req.source, req.target)
    except currency.CurrencyError as exc:
        raise HTTPException(502, str(exc))


@app.get("/api/lists", dependencies=[Depends(require_password)])
def lists_get():
    return {"lists": lists.all_lists(), "categories": lists.CATEGORIES}


def _build_items(raw: list[VocabItem], source: str, target: str) -> list[dict]:
    entries = [(i.a.strip(), i.b.strip()) for i in raw if i.a.strip()]
    if not entries or len(entries) > lists.MAX_ITEMS:
        raise HTTPException(400, f"1 bis {lists.MAX_ITEMS} Einträge nötig")
    items = []
    for a, b in entries:
        if len(a) > 100 or len(b) > 100:
            raise HTTPException(413, "Einträge max. 100 Zeichen")
        if not b:
            b = translate_text(a, source, target)[0]
        items.append({"a": a, "b": b})
    return items


@app.post("/api/lists")
def lists_add(req: NewList, user: users.User = Depends(require_password)):
    if not req.title.strip():
        raise HTTPException(400, "Titel fehlt")
    if req.source not in LANGUAGES or req.target not in LANGUAGES or req.source == req.target:
        raise HTTPException(400, "Ungültige Sprachwahl")
    category = req.category if req.category in lists.CATEGORIES else "Sonstiges"
    items = _build_items(req.items, req.source, req.target)
    try:
        return lists.add(user.name, req.title, req.source, req.target, items, category)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/lists/{list_id}/items")
def lists_add_items(list_id: str, req: MoreItems, user: users.User = Depends(require_password)):
    found = next((x for x in lists.all_lists() if x["id"] == list_id), None)
    if found is None:
        raise HTTPException(404, "Liste nicht gefunden")
    if not user.admin and found["owner"] != user.name:
        raise HTTPException(403, "Nur Besitzer oder Admin dürfen ergänzen")
    known = {i["a"].casefold() for i in found["items"]}  # Doppelte vorab raus, damit nichts unnötig übersetzt wird
    fresh = [i for i in req.items if i.a.strip().casefold() not in known]
    items = _build_items(fresh, found["source"], found["target"])
    try:
        return lists.add_items(list_id, user.name, user.admin, items)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.delete("/api/lists/{list_id}")
def lists_delete(list_id: str, user: users.User = Depends(require_password)):
    result = lists.delete(list_id, user.name, user.admin)
    if result is None:
        raise HTTPException(403, "Nur Besitzer oder Admin dürfen löschen")
    if result is False:
        raise HTTPException(404, "Liste nicht gefunden")
    return {"ok": True}


def _full_phrase(texts: dict[str, str], category: str) -> dict:
    """Ergänzt fehlende Sprachen per Übersetzung (cache-gestützt)."""
    src = next(iter(texts))
    out = {"c": category}
    for lang in LANGUAGES:
        out[lang] = texts[lang] if lang in texts else translate_text(texts[src], src, lang)[0]
    return out


@app.get("/api/my-phrases")
def my_phrases(user: users.User = Depends(require_password)):
    return {"phrases": userphrases.mine(user.name)}


@app.post("/api/my-phrases")
def my_phrases_add(req: NewPhrase, user: users.User = Depends(require_password)):
    if req.lang not in LANGUAGES:
        raise HTTPException(400, "Ungültige Sprachwahl")
    text = req.text.strip()
    if not text or len(text) > 200:
        raise HTTPException(400, "1 bis 200 Zeichen nötig")
    phrase = _full_phrase({req.lang: text}, req.category.strip()[:30] or "Eigene")
    try:
        added = userphrases.add_many(user.name, [{**phrase, "de": phrase["de"]}])
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"added": len(added)}


@app.post("/api/my-phrases/from-list")
def my_phrases_from_list(req: PhrasesFromList, user: users.User = Depends(require_password)):
    found = next((x for x in lists.all_lists() if x["id"] == req.list_id), None)
    if found is None:
        raise HTTPException(404, "Liste nicht gefunden")
    existing = {p["de"].casefold() for p in userphrases.mine(user.name)}
    entries = []
    for it in found["items"]:
        texts = {found["source"]: it["a"], found["target"]: it["b"]}
        if texts.get("de", "").casefold() in existing:
            continue
        entries.append(_full_phrase(texts, "Eigene"))
    try:
        added = userphrases.add_many(user.name, entries)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"added": len(added)}


@app.delete("/api/my-phrases/{phrase_id}")
def my_phrases_delete(phrase_id: str, user: users.User = Depends(require_password)):
    if not userphrases.delete(user.name, phrase_id):
        raise HTTPException(404, "Phrase nicht gefunden")
    return {"ok": True}


def _room_call(fn, *args):
    try:
        return fn(*args)
    except rooms.RoomError as exc:
        raise HTTPException(404, str(exc))


@app.post("/api/rooms")
def room_enter(req: RoomJoin, user: users.User = Depends(require_password)):
    if req.lang not in LANGUAGES or not 8 <= len(req.cid) <= 64:
        raise HTTPException(400, "Ungültige Anfrage")
    if req.code:
        room = _room_call(rooms.join, req.code, req.cid, user.name, req.lang)
    else:
        room = _room_call(rooms.create, req.cid, user.name, req.lang)
    return {"room": room.code}


@app.post("/api/rooms/{code}/messages", dependencies=[Depends(require_password)])
def room_post(code: str, req: RoomMessage):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Kein Text")
    if len(text) > max_input_chars():
        raise HTTPException(413, f"Text zu lang (max. {max_input_chars()} Zeichen)")
    room = _room_call(rooms.get, code)
    msg = _room_call(rooms.post, room, req.cid, text)
    return {"id": msg["id"]}


@app.get("/api/rooms/{code}/messages", dependencies=[Depends(require_password)])
def room_fetch(code: str, cid: str, after: int = 0):
    room = _room_call(rooms.get, code)
    return _room_call(rooms.fetch, room, cid, after, lambda t, s_, g: translate_text(t, s_, g)[0])


@app.delete("/api/rooms/{code}", dependencies=[Depends(require_password)])
def room_leave(code: str, cid: str):
    rooms.leave(code, cid)
    return {"ok": True}


@app.get("/api/admin/users", dependencies=[Depends(require_admin)])
def admin_list():
    return {"users": users.list_users()}


@app.post("/api/admin/users", dependencies=[Depends(require_admin)])
def admin_create(req: NewUser):
    if not req.name.strip():
        raise HTTPException(400, "Name fehlt")
    return users.create_user(req.name)


@app.delete("/api/admin/users/{user_id}", dependencies=[Depends(require_admin)])
def admin_delete(user_id: str):
    if not users.delete_user(user_id):
        raise HTTPException(404, "Unbekannter Zugang")
    return {"ok": True}


frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
