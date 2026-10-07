# Spezifikation: Übersetzer-PWA

## Ziel
Eine PWA, mit der man Text zwischen Deutsch, Französisch und Kinyarwanda übersetzen kann. Eingabe per Tippen oder iOS-Diktat, Ausgabe als Text, bei Deutsch und Französisch zusätzlich vorgelesen. Nutzung nur mit Internet.

## Architektur
iPhone (PWA in Safari) → Reverse Proxy (HTTPS) → FastAPI-Backend (Docker auf Unraid) → Übersetzungs-API (extern).
In Stufe 3 kommt ein zweiter Container für Kinyarwanda-Spracherkennung dazu.

## Übersetzungsanbieter (umschaltbar)
| Anbieter | Verwendung | Hinweis |
|---|---|---|
| Google Cloud Translation (v2, REST) | **Standard**, bei Kinyarwanda am stärksten und im Freikontingent (500.000 Zeichen/Monat) | übersetzt Satz für Satz ohne Kontext |
| Google Gemini (Flash-Lite) | Alternative mit Anweisungen („formell, einfach“) | Modellname per Env |
| Anthropic Claude (Haiku 4.5) | Alternative | `claude-haiku-4-5-20251001` |
| OpenAI (GPT-5.4 mini) | Alternative | Modellname per Env |

KI-Modelle bekommen einen Systemprompt: nur die Übersetzung ausgeben, keine Erklärungen, Ton und Formatierung des Originals beibehalten.
DeepSeek ist bewusst nicht enthalten (keine Kinyarwanda-Tests gefunden, Daten auf Servern in China).

## Stufenplan
**Stufe 1 (Text-Prototyp)**
- Projektgerüst, Dockerfile, docker-compose, `.env.example`
- Endpunkte: `POST /api/translate`, `GET /api/providers`, `GET /health`
- Frontend: Textfeld, zwei Dropdowns (von/nach), Anbieter-Auswahl, Ausgabefeld, Kopieren-Button
- Passwortschutz
- Tests für Provider-Module mit gemockten HTTP-Aufrufen

**Stufe 2 (Sprache und PWA)**
- Sprachausgabe für Deutsch und Französisch (`speechSynthesis`), Stimme wählbar
- Vorlesen-Button, Tauschen-Button (Sprachen vertauschen)
- Verlauf der letzten Übersetzungen im `localStorage`
- `manifest.json`, Icon, Service Worker für die App-Hülle, Home-Bildschirm-Installation auf dem iPhone
- Test auf dem echten iPhone: Funktioniert die Web Speech API in der installierten PWA? Wenn nein, nur das iOS-Diktat nutzen.

**Stufe 3 (optional, nur nach Qualitätstest)**
- Aufnahme im Browser (MediaRecorder), Upload als WAV 16 kHz Mono
- Zweiter Container mit NVIDIA-Modell `stt_rw_conformer_transducer_large` (CC BY 4.0, ca. 16 % Wortfehlerrate) oder `stt_rw_conformer_ctc_large`, läuft auf der CPU
- Endpunkt `POST /api/transcribe/rw`
- Vorher messen: Dauer pro Satz auf dem i5-11400; nur weiterbauen, wenn es für Alltagssätze brauchbar ist
- Kinyarwanda-Sprachausgabe ist nicht geplant

## Qualitätstest vor Stufe 3
20–30 Alltagssätze (Arzt, Behörde, Einkaufen, Smalltalk) von einer Kinyarwanda-Muttersprachlerin oder einem -Muttersprachler bewerten lassen, für jeden Anbieter, beide Richtungen. Ergebnis in `docs/TESTERGEBNISSE.md` festhalten.

## Sicherheit und Datenschutz
- Keys nur im Backend. Ausgabelimits in allen Anbieterkonten setzen.
- Texte gehen an den gewählten Anbieter; bei kostenlosen Stufen die Nutzungsbedingungen zur Datenverwendung prüfen.
- Die Web Speech API in Safari kann Audio an Apple senden.
- Wichtige Gespräche (Arzt, Behörde) nicht allein auf die Übersetzung verlassen.

## Offene Fragen
- Funktioniert die Web Speech API in der installierten iOS-PWA?
- Wie schnell ist das NVIDIA-Modell auf dem i5-11400?
- Welcher Anbieter ist bei Kinyarwanda nach dem Muttersprachler-Test der beste?
