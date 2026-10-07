import base64

import httpx

from .config import env

TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize"
VOICE_LANGS = {"de": "de-DE", "fr": "fr-FR", "en": "en-US"}  # Kinyarwanda wird nicht vorgelesen


class TTSError(Exception):
    pass


def api_key() -> str:
    """Eigener Key möglich, sonst der Google-Translate-Key (gleiches Google-Projekt)."""
    return env("GOOGLE_TTS_API_KEY") or env("GOOGLE_TRANSLATE_API_KEY")


def synthesize(text: str, lang: str, client: httpx.Client | None = None) -> bytes:
    if lang not in VOICE_LANGS:
        raise TTSError("Sprache wird nicht vorgelesen")
    try:
        resp = (client or httpx.Client(timeout=30)).post(
            TTS_URL,
            params={"key": api_key()},
            json={
                "input": {"text": text},
                "voice": {"languageCode": VOICE_LANGS[lang]},
                "audioConfig": {"audioEncoding": "MP3"},
            },
        )
        resp.raise_for_status()
        return base64.b64decode(resp.json()["audioContent"])
    except httpx.HTTPStatusError as exc:
        raise TTSError(f"Google Text-to-Speech: HTTP {exc.response.status_code}") from exc
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        raise TTSError("Google Text-to-Speech nicht erreichbar") from exc
