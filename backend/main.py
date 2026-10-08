from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import cache, currency, ocr, tts, users
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


@app.post("/api/translate", dependencies=[Depends(require_password)])
def translate(req: TranslateRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Kein Text")
    if len(text) > max_input_chars():
        raise HTTPException(413, f"Text zu lang (max. {max_input_chars()} Zeichen)")
    if req.source not in LANGUAGES or req.target not in LANGUAGES or req.source == req.target:
        raise HTTPException(400, "Ungültige Sprachwahl")
    providers_ = available_providers()
    if not providers_:
        raise HTTPException(503, "Kein Anbieter konfiguriert")
    name = req.provider or next(iter(providers_))
    provider = providers_.get(name)
    if provider is None:
        raise HTTPException(400, "Unbekannter Anbieter")
    cached = cache.get(name, req.source, req.target, text)
    if cached is not None:
        return {"translation": cached, "provider": name, "cached": True}
    try:
        translation = provider.translate(text, req.source, req.target)
    except ProviderError as exc:
        raise HTTPException(502, str(exc))
    cache.put(name, req.source, req.target, text, translation)
    return {"translation": translation, "provider": name}


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
