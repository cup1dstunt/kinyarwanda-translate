import httpx

from .config import env
from .httperror import describe

VISION_URL = "https://vision.googleapis.com/v1/images:annotate"
MAX_IMAGE_BASE64 = 6_000_000  # ca. 4,5 MB Bild; das Frontend verkleinert vorher


class OCRError(Exception):
    pass


def api_key() -> str:
    """Eigener Key möglich, sonst der Google-Translate-Key (gleiches Google-Projekt)."""
    return env("GOOGLE_VISION_API_KEY") or env("GOOGLE_TRANSLATE_API_KEY")


def detect_text(image_base64: str, client: httpx.Client | None = None) -> str:
    try:
        resp = (client or httpx.Client(timeout=30)).post(
            VISION_URL,
            params={"key": api_key()},
            json={"requests": [{"image": {"content": image_base64}, "features": [{"type": "TEXT_DETECTION"}]}]},
        )
        resp.raise_for_status()
        result = resp.json()["responses"][0]
    except httpx.HTTPStatusError as exc:
        raise OCRError(f"Google Cloud Vision: {describe(exc)}") from exc
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        raise OCRError("Google Cloud Vision nicht erreichbar") from exc
    if "error" in result:
        raise OCRError("Google Cloud Vision: " + result["error"].get("message", "Fehler"))
    return result.get("fullTextAnnotation", {}).get("text", "").strip()
