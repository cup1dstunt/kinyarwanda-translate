from ..config import env
from .anthropic import Anthropic
from .base import LANGUAGES, Provider, ProviderError
from .gemini import Gemini
from .google import GoogleTranslate
from .openai import OpenAI

__all__ = ["LANGUAGES", "Provider", "ProviderError", "available_providers"]


def available_providers() -> dict[str, Provider]:
    """Nur Anbieter mit gesetztem Key, Google zuerst (Standard)."""
    candidates = [
        (GoogleTranslate, "GOOGLE_TRANSLATE_API_KEY", None),
        (Gemini, "GEMINI_API_KEY", "GEMINI_MODEL"),
        (Anthropic, "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"),
        (OpenAI, "OPENAI_API_KEY", "OPENAI_MODEL"),
    ]
    result = {}
    for cls, key_var, model_var in candidates:
        key = env(key_var)
        if key:
            result[cls.name] = cls(key, env(model_var) if model_var else "")
    return result
