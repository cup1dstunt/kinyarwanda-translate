from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import cache, currency, ocr, rooms, tts, users
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
