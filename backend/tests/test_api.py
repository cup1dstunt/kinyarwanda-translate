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
def web(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
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
    assert "Mukunzi Talk" in web.get("/").text


def test_health_shows_version(web, monkeypatch):
    monkeypatch.setenv("APP_VERSION", "7-abc1234")
    assert web.get("/health").json() == {"status": "ok", "version": "7-abc1234"}


def test_tts_synthesize():
    import base64
    from backend import tts

    def check(req):
        assert b"fr-FR" in req.content

    audio = tts.synthesize("Bonjour", "fr", client_for({"audioContent": base64.b64encode(b"ID3mp3").decode()}, check))
    assert audio == b"ID3mp3"


def test_tts_endpoint(web, monkeypatch):
    from backend import tts

    monkeypatch.setattr(tts, "synthesize", lambda text, lang: b"ID3mp3")
    r = web.post("/api/tts", headers=H, json={"text": "Bonjour", "lang": "fr"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content == b"ID3mp3"
    assert web.get("/api/providers", headers=H).json()["tts"] is True


def test_ocr_detect_text():
    from backend import ocr

    payload = {"responses": [{"fullTextAnnotation": {"text": "Murakaza neza\n"}}]}
    assert ocr.detect_text("aGVsbG8=", client_for(payload)) == "Murakaza neza"


def test_ocr_vision_error():
    from backend import ocr

    payload = {"responses": [{"error": {"message": "Bad image data."}}]}
    with pytest.raises(ocr.OCRError, match="Bad image data"):
        ocr.detect_text("xx", client_for(payload))


def test_ocr_endpoint(web, monkeypatch):
    from backend import ocr

    monkeypatch.setattr(ocr, "detect_text", lambda image: "Welcome")
    assert web.post("/api/ocr", headers=H, json={"image": "aGVsbG8="}).json() == {"text": "Welcome"}
    assert web.post("/api/ocr", headers=H, json={"image": ""}).status_code == 413


def test_english_supported(web):
    assert "en" in web.get("/api/providers", headers=H).json()["languages"]


def test_provider_error_shows_google_message():
    from backend.providers import ProviderError

    def handler(request):
        return httpx.Response(403, json={"error": {"message": "Requests to this API are blocked."}})

    p = GoogleTranslate("k", client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(ProviderError, match="HTTP 403: Requests to this API are blocked"):
        p.translate("Hallo", "de", "rw")


def test_phrasebook_complete(web):
    phrases = web.get("/phrases.json").json()
    assert {p["c"] for p in phrases} >= {"Alltagssprache", "Arzt", "Behörde", "Einkaufen"}
    dictionary = web.get("/dictionary.json").json()
    assert len(dictionary) > 200
    for p in phrases + dictionary:
        assert all(p.get(k, "").strip() for k in ("de", "fr", "en", "rw")), p
    de = [p["de"] for p in phrases + dictionary]
    assert len(de) == len(set(de))  # keine doppelten deutschen Einträge
    entries = _i18n_entries()
    assert [c for c in {p["c"] for p in phrases + dictionary} if c not in entries] == []


def test_access_codes(web):
    code = web.post("/api/admin/users", headers=H, json={"name": "Anna"}).json()
    hu = {"X-App-Password": code["code"]}
    me = web.get("/api/providers", headers=hu).json()["me"]
    assert me == {"name": "Anna", "admin": False}
    assert web.get("/api/admin/users", headers=hu).status_code == 403
    assert web.get("/api/admin/users", headers=H).json()["users"][0]["name"] == "Anna"
    assert web.delete(f"/api/admin/users/{code['id']}", headers=H).status_code == 200
    assert web.get("/api/providers", headers=hu).status_code == 401
    assert web.delete("/api/admin/users/nope", headers=H).status_code == 404


def test_translation_cache(web, monkeypatch):
    calls = []

    class Fake:
        def translate(self, text, source, target):
            calls.append(text)
            return "Muraho"

    monkeypatch.setattr("backend.main.available_providers", lambda: {"google": Fake()})
    body = {"text": "Hallo", "source": "de", "target": "rw"}
    first = web.post("/api/translate", headers=H, json=body).json()
    second = web.post("/api/translate", headers=H, json=body).json()
    assert first["translation"] == second["translation"] == "Muraho"
    assert second["cached"] is True and calls == ["Hallo"]


def test_room_chat_translates_per_reader(web, monkeypatch):
    calls = []

    class Fake:
        def translate(self, text, source, target):
            calls.append((text, target))
            return f"[{target}] {text}"

    monkeypatch.setattr("backend.main.available_providers", lambda: {"google": Fake()})
    a, b = "a" * 12, "b" * 12
    code = web.post("/api/rooms", headers=H, json={"cid": a, "lang": "de"}).json()["room"]
    assert web.post("/api/rooms", headers=H, json={"cid": b, "lang": "rw", "code": code.lower()}).status_code == 200
    assert web.post(f"/api/rooms/{code}/messages", headers=H, json={"cid": a, "text": "Hallo"}).status_code == 200
    got = web.get(f"/api/rooms/{code}/messages", params={"cid": b}, headers=H).json()
    assert got["messages"][0]["text"] == "[rw] Hallo" and got["messages"][0]["original"] == "Hallo"
    mine = web.get(f"/api/rooms/{code}/messages", params={"cid": a}, headers=H).json()["messages"][0]
    assert mine["mine"] is True and mine["text"] == "Hallo"
    web.get(f"/api/rooms/{code}/messages", params={"cid": b}, headers=H)
    assert calls == [("Hallo", "rw")]  # nur einmal übersetzt
    later = web.get(f"/api/rooms/{code}/messages", params={"cid": b, "after": 1}, headers=H).json()
    assert later["messages"] == [] and len(later["members"]) == 2


def test_room_errors(web):
    assert web.post("/api/rooms", headers=H, json={"cid": "c" * 12, "lang": "de", "code": "NOPE1"}).status_code == 404
    assert web.post("/api/rooms", json={"cid": "c" * 12, "lang": "de"}).status_code == 401
    code = web.post("/api/rooms", headers=H, json={"cid": "a" * 12, "lang": "de"}).json()["room"]
    r = web.get(f"/api/rooms/{code}/messages", params={"cid": "z" * 12}, headers=H)
    assert r.status_code == 404


def test_vocab_lists(web, monkeypatch):
    class Fake:
        def translate(self, text, source, target):
            return f"[{target}] {text}"

    monkeypatch.setattr("backend.main.available_providers", lambda: {"google": Fake()})
    body = {"title": "Markt", "source": "de", "target": "rw",
            "items": [{"a": "Wasser", "b": "amazi"}, {"a": "Brot"}, {"a": "  "}]}
    code = web.post("/api/admin/users", headers=H, json={"name": "Anna"}).json()["code"]
    made = web.post("/api/lists", headers=H, json={**body, "to": ["Anna"]}).json()
    assert made["items"] == [{"a": "Wasser", "b": "amazi"}, {"a": "Brot", "b": "[rw] Brot"}]
    ha = {"X-App-Password": code}
    assert web.get("/api/lists", headers=ha).json()["lists"][0]["owner"] == "Admin"
    assert web.get("/api/lists", headers=ha).json()["categories"][-1] == "Sonstiges"
    assert made["category"] == "Sonstiges"
    # Wörter ergänzen: nur Besitzer/Admin, Doppelte werden übersprungen, fehlende Übersetzung automatisch
    more = {"items": [{"a": "wasser", "b": "x"}, {"a": "Milch"}]}
    assert web.post(f"/api/lists/{made['id']}/items", headers=ha, json=more).status_code == 403
    grown = web.post(f"/api/lists/{made['id']}/items", headers=H, json=more).json()
    assert [i["a"] for i in grown["items"]] == ["Wasser", "Brot", "Milch"]
    assert grown["items"][2]["b"] == "[rw] Milch"
    assert web.post("/api/lists/nope/items", headers=H, json=more).status_code == 404
    assert web.delete(f"/api/lists/{made['id']}", headers=ha).status_code == 403  # fremde Liste
    assert web.post("/api/lists", headers=ha, json={**body, "title": ""}).status_code == 400
    mine = web.post("/api/lists", headers=ha, json={**body, "category": "Essen & Einkaufen"}).json()
    assert mine["category"] == "Essen & Einkaufen"
    assert web.post("/api/lists", headers=ha, json={**body, "category": "Unsinn"}).json()["category"] == "Sonstiges"
    assert web.delete(f"/api/lists/{mine['id']}", headers=ha).status_code == 200
    assert web.delete(f"/api/lists/{made['id']}", headers=H).status_code == 200
    assert web.delete("/api/lists/nope", headers=H).status_code == 404


def _i18n_entries():
    import json
    import re
    from pathlib import Path

    text = (Path(__file__).resolve().parents[2] / "frontend" / "i18n.js").read_text(encoding="utf-8")
    entries = {}
    for line in text.splitlines():
        m = re.match(r'^  ("(?:[^"\\]|\\.)*"): (\{.*\}),$', line)
        if m:
            entries[json.loads(m.group(1))] = json.loads(m.group(2))
    return entries


def test_i18n_complete():
    import re

    entries = _i18n_entries()
    assert len(entries) > 100
    for key, tr in entries.items():
        assert set(tr) == {"en", "fr", "rw"} and all(v.strip() for v in tr.values()), key
        for v in tr.values():
            assert sorted(re.findall(r"\{\d+\}", v)) == sorted(re.findall(r"\{\d+\}", key)), key


def test_i18n_covers_html_and_server_messages():
    import re
    from html.parser import HTMLParser
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    entries = _i18n_entries()
    skip = {"Ikiraro", "Mukunzi Talk", "RWF", "EUR"}

    class Collect(HTMLParser):
        def __init__(self):
            super().__init__()
            self.stack, self.found = [], []

        def handle_starttag(self, tag, attrs):
            for k, v in attrs:
                if k in ("placeholder", "title", "aria-label") and v and re.search("[A-Za-z]{3}", v):
                    self.found.append(v)
            if tag in ("script", "style", "svg", "title", "h1"):
                self.stack.append([tag, 0, ""])
            elif tag not in ("input", "meta", "link", "use", "path", "br", "textarea"):
                if self.stack:
                    self.stack[-1][1] += 1
                self.stack.append([tag, 0, ""])

        def handle_endtag(self, tag):
            if self.stack and self.stack[-1][0] == tag:
                t, kids, text = self.stack.pop()
                if t not in ("script", "style", "svg", "title", "h1") and kids == 0 and text.strip():
                    self.found.append(text.strip())

        def handle_data(self, data):
            if self.stack:
                self.stack[-1][2] += data

    parser = Collect()
    parser.feed((root / "frontend" / "index.html").read_text(encoding="utf-8"))
    missing = [s for s in parser.found if s not in entries and s not in skip and re.search("[A-Za-z]{3}", s) and s != "0 / 2000"]
    assert not missing, missing

    main = (root / "backend" / "main.py").read_text(encoding="utf-8")
    messages = re.findall(r'HTTPException\(\d+, "([^"{]+)"\)', main)
    messages += re.findall(r'raise RoomError\("([^"{]+)"\)', (root / "backend" / "rooms.py").read_text(encoding="utf-8"))
    assert [m for m in messages if m not in entries] == []


def test_send_lists(web):
    body = {"title": "Markt", "source": "de", "target": "rw", "items": [{"a": "Wasser", "b": "amazi"}]}
    anna = web.post("/api/admin/users", headers=H, json={"name": "Anna"}).json()["code"]
    ben = web.post("/api/admin/users", headers=H, json={"name": "Ben"}).json()["code"]
    ha, hb = {"X-App-Password": anna}, {"X-App-Password": ben}
    assert web.get("/api/people", headers=ha).json()["people"] == ["Admin", "Ben"]
    mine = web.post("/api/lists", headers=ha, json={**body, "to": ["Ben", "Anna"]}).json()
    assert mine["to"] == ["Ben"]  # sich selbst filtert er heraus
    assert web.post("/api/lists", headers=ha, json={**body, "to": ["Niemand"]}).status_code == 400
    private = web.post("/api/lists", headers=ha, json=body).json()
    assert [x["id"] for x in web.get("/api/lists", headers=hb).json()["lists"]] == [mine["id"]]  # nur die gesendete
    assert web.get("/api/lists", headers=H).json()["lists"] == []  # auch der Admin sieht fremde Listen nicht
    # Empfänger darf nicht ergänzen, senden oder löschen, aber „entfernen“
    assert web.post(f"/api/lists/{mine['id']}/items", headers=hb, json={"items": [{"a": "x", "b": "y"}]}).status_code == 403
    assert web.post(f"/api/lists/{mine['id']}/share", headers=hb, json={"to": ["Admin"]}).status_code == 403
    assert web.delete(f"/api/lists/{mine['id']}", headers=hb).status_code == 403
    assert web.post(f"/api/lists/{private['id']}/leave", headers=hb).status_code == 404
    shared = web.post(f"/api/lists/{private['id']}/share", headers=ha, json={"to": ["Admin"]}).json()
    assert shared["to"] == ["Admin"]
    assert len(web.get("/api/lists", headers=H).json()["lists"]) == 1
    assert web.post(f"/api/lists/{mine['id']}/leave", headers=hb).status_code == 200
    assert web.get("/api/lists", headers=hb).json()["lists"] == []

def test_own_phrases(web, monkeypatch):
    class Fake:
        def translate(self, text, source, target):
            return f"[{target}] {text}"

    monkeypatch.setattr("backend.main.available_providers", lambda: {"google": Fake()})
    r = web.post("/api/my-phrases", headers=H, json={"text": "Guten Appetit", "lang": "de", "category": "Essen"})
    assert r.json() == {"added": 1}
    mine = web.get("/api/my-phrases", headers=H).json()["phrases"]
    assert mine[0]["de"] == "Guten Appetit" and mine[0]["rw"] == "[rw] Guten Appetit" and mine[0]["c"] == "Essen"
    assert web.post("/api/my-phrases", headers=H, json={"text": "Guten Appetit", "lang": "de"}).json() == {"added": 0}
    made = web.post("/api/lists", headers=H, json={"title": "T", "source": "de", "target": "rw",
                                                   "items": [{"a": "Wasser", "b": "amazi"}]}).json()
    assert web.post("/api/my-phrases/from-list", headers=H, json={"list_id": made["id"]}).json() == {"added": 1}
    wasser = [p for p in web.get("/api/my-phrases", headers=H).json()["phrases"] if p["de"] == "Wasser"][0]
    assert wasser["rw"] == "amazi" and wasser["fr"] == "[fr] Wasser"
    assert web.post("/api/my-phrases/from-list", headers=H, json={"list_id": "nope"}).status_code == 404
    code = web.post("/api/admin/users", headers=H, json={"name": "Anna"}).json()["code"]
    assert web.get("/api/my-phrases", headers={"X-App-Password": code}).json()["phrases"] == []  # pro Person getrennt
    assert web.delete(f"/api/my-phrases/{wasser['id']}", headers=H).status_code == 200
    assert web.delete(f"/api/my-phrases/{wasser['id']}", headers=H).status_code == 404
