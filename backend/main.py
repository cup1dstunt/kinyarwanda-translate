from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import cache, chats, currency, lists, ocr, tts, userphrases, users
from .config import env, max_input_chars
from .providers import LANGUAGES, ProviderError, available_providers

app = FastAPI(title="Übersetzer-PWA")


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    """App-Dateien immer beim Server nachfragen (ETag macht das billig).

    Ohne diese Angabe hält iOS alte Dateien fest; dann passen index.html und app.js
    nach einem Update nicht zusammen und die App bleibt leer.
    """
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


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
    to: list[str] = []


class ShareList(BaseModel):
    to: list[str]


class MoreItems(BaseModel):
    items: list[VocabItem]


class NewPhrase(BaseModel):
    text: str
    lang: str
    category: str = "Eigene"


class PhrasesFromList(BaseModel):
    list_id: str


class NewChat(BaseModel):
    title: str = ""
    members: list[str]


class ChatMessage(BaseModel):
    lang: str
    text: str = ""
    image: str = ""  # JPEG als Base64 ohne "data:"-Präfix


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
def lists_get(user: users.User = Depends(require_password)):
    return {"lists": lists.visible_lists(user.name), "categories": lists.CATEGORIES}


def _known_recipients(names: list[str], me: str) -> list[str]:
    valid = {u["name"] for u in users.list_users()} | {"Admin"}
    unknown = [n for n in names if n not in valid]
    if unknown:
        raise HTTPException(400, "Unbekannte Person")
    return [n for n in dict.fromkeys(names) if n != me]


@app.get("/api/people")
def people(user: users.User = Depends(require_password)):
    names = {u["name"] for u in users.list_users()} | {"Admin"}
    return {"people": sorted(names - {user.name}, key=str.casefold)}


@app.post("/api/lists/{list_id}/share")
def lists_share(list_id: str, req: ShareList, user: users.User = Depends(require_password)):
    result = lists.share(list_id, user.name, user.admin, _known_recipients(req.to, user.name))
    if result is None:
        raise HTTPException(403, "Nur Besitzer oder Admin dürfen senden")
    if result is False:
        raise HTTPException(404, "Liste nicht gefunden")
    return result


@app.post("/api/lists/{list_id}/leave")
def lists_leave(list_id: str, user: users.User = Depends(require_password)):
    if not lists.leave(list_id, user.name):
        raise HTTPException(404, "Liste nicht gefunden")
    return {"ok": True}


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
        return lists.add(user.name, req.title, req.source, req.target, items, category, _known_recipients(req.to, user.name))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/lists/{list_id}/items")
def lists_add_items(list_id: str, req: MoreItems, user: users.User = Depends(require_password)):
    found = next((x for x in lists.visible_lists(user.name) if x["id"] == list_id), None)
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
    found = next((x for x in lists.visible_lists(user.name) if x["id"] == req.list_id), None)
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


def _chat_call(fn, *args):
    try:
        return fn(*args)
    except chats.ChatError as exc:
        msg = str(exc)
        status = 404 if "nicht gefunden" in msg else 403 if msg.startswith("Nur eigene") else 400
        raise HTTPException(status, msg)


@app.get("/api/chats")
def chat_list(user: users.User = Depends(require_password)):
    return {"chats": chats.mine(user.name)}


@app.post("/api/chats")
def chat_create(req: NewChat, user: users.User = Depends(require_password)):
    return _chat_call(chats.create, user.name, req.title, _known_recipients(req.members, user.name))


@app.post("/api/chats/{chat_id}/messages")
def chat_post(chat_id: str, req: ChatMessage, user: users.User = Depends(require_password)):
    text = req.text.strip()
    if not text and not req.image:
        raise HTTPException(400, "Kein Text")
    if len(text) > max_input_chars():
        raise HTTPException(413, f"Text zu lang (max. {max_input_chars()} Zeichen)")
    if req.lang not in LANGUAGES:
        raise HTTPException(400, "Ungültige Sprachwahl")
    if len(req.image) > ocr.MAX_IMAGE_BASE64:
        raise HTTPException(413, "Bild fehlt oder ist zu groß")
    msg = _chat_call(chats.post, chat_id, user.name, req.lang, text, req.image)
    return {"id": msg["id"]}


@app.get("/api/chats/{chat_id}/messages")
def chat_fetch(chat_id: str, lang: str, after: int = 0, user: users.User = Depends(require_password)):
    if lang not in LANGUAGES:
        raise HTTPException(400, "Ungültige Sprachwahl")
    return _chat_call(chats.fetch, chat_id, user.name, lang, after, lambda t, s_, g: translate_text(t, s_, g)[0])


@app.delete("/api/chats/{chat_id}/messages/{msg_id}")
def chat_delete_message(chat_id: str, msg_id: int, user: users.User = Depends(require_password)):
    _chat_call(chats.delete_message, chat_id, user.name, msg_id)
    return {"ok": True}


@app.get("/api/chats/{chat_id}/images/{file}")
def chat_image(chat_id: str, file: str, user: users.User = Depends(require_password)):
    path = _chat_call(chats.image_path, chat_id, user.name, file)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=31536000"})


@app.delete("/api/chats/{chat_id}")
def chat_leave(chat_id: str, user: users.User = Depends(require_password)):
    _chat_call(chats.leave, chat_id, user.name)
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
