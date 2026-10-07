import hmac
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import currency, tts
from .config import env, max_input_chars
from .providers import LANGUAGES, ProviderError, available_providers

app = FastAPI(title="Übersetzer-PWA")


def require_password(x_app_password: str = Header(default="")):
    expected = env("APP_PASSWORD")
    if not expected or not hmac.compare_digest(x_app_password, expected):
        raise HTTPException(401, "Falsches Passwort")


class TranslateRequest(BaseModel):
    text: str
    source: str
    target: str
    provider: str | None = None


class SpeakRequest(BaseModel):
    text: str
    lang: str


class ConvertRequest(BaseModel):
    amount: float
    source: str
    target: str


@app.get("/health")
def health():
    return {"status": "ok", "version": env("APP_VERSION", "dev")}


@app.get("/api/providers", dependencies=[Depends(require_password)])
def providers():
    names = list(available_providers())
    return {
        "providers": names,
        "default": names[0] if names else None,
        "languages": LANGUAGES,
        "tts": bool(tts.api_key()),
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
    try:
        return {"translation": provider.translate(text, req.source, req.target), "provider": name}
    except ProviderError as exc:
        raise HTTPException(502, str(exc))


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


@app.post("/api/convert", dependencies=[Depends(require_password)])
def convert(req: ConvertRequest):
    if req.amount < 0 or req.amount > 1e12:
        raise HTTPException(400, "Ungültiger Betrag")
    try:
        return currency.convert(req.amount, req.source, req.target)
    except currency.CurrencyError as exc:
        raise HTTPException(502, str(exc))


frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
