# Übersetzer-PWA (Deutsch / Französisch / Kinyarwanda)

Persönliche Übersetzungs-App als PWA für das iPhone. Läuft als Docker-Container auf einem Unraid-Server (Intel i5-11400, **keine NVIDIA-GPU**), erreichbar über Reverse Proxy mit HTTPS.

Die vollständige Spezifikation steht in `docs/SPEC.md`. Bei Widersprüchen gilt die Spezifikation.

## Stack
- Backend: Python 3.12 + FastAPI, liefert zusätzlich die statischen PWA-Dateien aus
- Frontend: reines HTML/CSS/JavaScript (kein Build-Schritt), `manifest.json`, Service Worker nur für die App-Hülle
- Deployment: ein Dockerfile + `docker-compose.yml`

## Regeln
- API-Keys nur als Umgebungsvariablen im Backend, **nie** im Frontend oder im Repository (`.env` ist in `.gitignore`).
- Jeder Übersetzungsanbieter bekommt ein eigenes Modul in `backend/providers/` mit derselben Schnittstelle: `translate(text, source, target) -> str`.
- Im Frontend erscheinen nur Anbieter, für die ein Key gesetzt ist (Endpunkt `GET /api/providers`).
- Sprachcodes: `de`, `fr`, `rw` (Kinyarwanda).
- Modellnamen kommen aus Umgebungsvariablen (siehe `.env.example`); vor dem Einsetzen die aktuellen Modellnamen in der Anbieter-Dokumentation prüfen.
- Sprachausgabe: nur Deutsch und Französisch über `speechSynthesis` im Browser. Kinyarwanda wird nur als Text angezeigt.
- Spracheingabe: iOS-Diktat der Tastatur in ein normales Textfeld. Die Web Speech API funktioniert in installierten iOS-PWAs laut WebKit-Bugtracker nicht zuverlässig; nur nutzen, wenn ein Test auf dem Gerät klappt.
- Zugriffsschutz: einfacher Passwortschutz im Backend (`APP_PASSWORD`), zusätzlich zum Reverse Proxy.
- Texte klein halten: Eingabe auf 2000 Zeichen begrenzen, damit keine hohen API-Kosten entstehen.

## Arbeitsweise
- Stufe für Stufe arbeiten (siehe Stufenplan in `docs/SPEC.md`), nach jeder Stufe lauffähig und getestet.
- Kleine Schritte, nach jedem Schritt kurz sagen, was geändert wurde und wie ich es testen kann.
- Keine zusätzlichen Abhängigkeiten ohne Begründung.
- Antworten und Kommentare auf Deutsch, Code und Variablennamen auf Englisch.

## Befehle
- Lokal starten: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`
- Tests: `pytest backend/tests`
