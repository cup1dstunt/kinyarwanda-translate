import httpx
import pytest
from fastapi.testclient import TestClient

from backend import currency
from backend.main import app
from backend.providers.anthropic import Anthropic
from backend.providers.gemini import Gemini
from backend.providers.google import GoogleTranslate
from backend.providers.openai import OpenAI


def client_for(payload, check=None):
    def handler(request: httpx.Request):
        if check:
            check(request)
        return httpx.Response(200, json=payload)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_google():
    p = GoogleTranslate("k", client=client_for({"data": {"translations": [{"translatedText": "Muraho"}]}}))
    assert p.translate("Hallo", "de", "rw") == "Muraho"


def test_gemini():
    payload = {"candidates": [{"content": {"parts": [{"text": " Muraho "}]}}]}
    assert Gemini("k", "m", client_for(payload)).translate("Hallo", "de", "rw") == "Muraho"


def test_anthropic_sends_system_prompt():
    def check(req):
        assert b"Kinyarwanda" in req.content and req.headers["x-api-key"] == "k"

    p = Anthropic("k", "m", client_for({"content": [{"text": "Muraho"}]}, check))
    assert p.translate("Hallo", "de", "rw") == "Muraho"


def test_openai():
    payload = {"choices": [{"message": {"content": "Bonjour"}}]}
    assert OpenAI("k", "m", client_for(payload)).translate("Hallo", "de", "fr") == "Bonjour"


@pytest.fixture
def web(monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "pw")
    monkeypatch.setenv("GOOGLE_TRANSLATE_API_KEY", "k")
    return TestClient(app)


H = {"X-App-Password": "pw"}


def test_password_required(web):
    assert web.get("/api/providers").status_code == 401
    assert web.get("/health").status_code == 200


def test_providers_only_with_key(web, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert web.get("/api/providers", headers=H).json()["providers"] == ["google"]


def test_translate_limits(web, monkeypatch):
    monkeypatch.setenv("MAX_INPUT_CHARS", "5")
    r = web.post("/api/translate", headers=H, json={"text": "zu lang!", "source": "de", "target": "rw"})
    assert r.status_code == 413
    r = web.post("/api/translate", headers=H, json={"text": "a", "source": "de", "target": "de"})
    assert r.status_code == 400


def test_convert(web, monkeypatch):
    monkeypatch.setitem(currency._cache, "rate", 1600.0)
    monkeypatch.setitem(currency._cache, "at", 9e12)
    r = web.post("/api/convert", headers=H, json={"amount": 10, "source": "EUR", "target": "RWF"})
    assert r.json()["result"] == 16000.0
    r = web.post("/api/convert", headers=H, json={"amount": 16000, "source": "RWF", "target": "EUR"})
    assert r.json()["result"] == 10.0
    r = web.post("/api/convert", headers=H, json={"amount": 1, "source": "EUR", "target": "USD"})
    assert r.status_code == 502


def test_pwa_files_served(web):
    assert web.get("/manifest.json").status_code == 200
    assert web.get("/sw.js").status_code == 200
    assert "Übersetzer" in web.get("/").text
