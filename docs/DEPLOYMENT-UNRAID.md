# Deployment auf Unraid (Docker Compose)

## Voraussetzungen
- Unraid mit aktiviertem Docker.
- Compose-Unterstützung: in den Community Applications das Plugin **Docker Compose Manager** installieren. Alternativ bringt Unraid ab 6.12 `docker compose` im Terminal mit.
- Eine Domain oder Subdomain (z. B. `uebersetzer.example.de`) für HTTPS. Ohne HTTPS lässt sich die PWA auf dem iPhone nicht installieren.

## 1. Dateien auf den Server
Auf Unraid brauchst du kein Git und keinen Quellcode. GitHub baut bei jedem Push auf `main` automatisch ein Image (`ghcr.io/cup1dstunt/kinyarwanda-translate:latest`). Auf den Server kommen nur zwei Dateien:

    mkdir -p /mnt/user/appdata/uebersetzer-pwa && cd /mnt/user/appdata/uebersetzer-pwa
    wget https://raw.githubusercontent.com/cup1dstunt/kinyarwanda-translate/main/docker-compose.yml
    wget https://raw.githubusercontent.com/cup1dstunt/kinyarwanda-translate/main/.env.example -O .env

Ist das Repo privat, funktioniert `wget` nicht. Lege die beiden Dateien dann per SMB-Freigabe ab.

Einmalig auf GitHub: Nach dem ersten erfolgreichen Build unter Profil → Packages → `kinyarwanda-translate` → Package settings die Sichtbarkeit auf „Public“ stellen (enthält nur den Code, keine Keys). Alternativ auf dem Server `docker login ghcr.io` mit einem Personal Access Token (`read:packages`).

## 2. Konfiguration
    nano .env

- `APP_PASSWORD` ändern.
- Mindestens `GOOGLE_TRANSLATE_API_KEY` eintragen, weitere Anbieter nur bei Bedarf.
- Modellnamen vor Nutzung in der Anbieter-Doku prüfen.
- In den Anbieterkonten Ausgabelimits setzen.

## 3. Starten und aktualisieren
    docker compose up -d

Prüfen: `http://UNRAID-IP:8085/health` muss `{"status":"ok"}` liefern.

Update auf die neueste Version: `docker compose pull && docker compose up -d`. Das kannst du als Skript im Plugin „User Scripts“ mit Zeitplan (z. B. nachts) einrichten. Alternativ erledigt das ein Watchtower-Container automatisch.

Mit dem Compose Manager: neuen Stack `uebersetzer-pwa` anlegen, den Ordner mit `docker-compose.yml` und `.env` angeben, „Compose Up“, später „Update Stack“.

## 4. HTTPS für das iPhone
Variante A: **Nginx Proxy Manager** (Community Applications).
1. Router: Ports 80 und 443 auf den Unraid-Server weiterleiten.
2. DNS: Subdomain auf deine öffentliche IP (DynDNS, falls nötig).
3. In Nginx Proxy Manager einen Proxy Host anlegen: Domain `uebersetzer.example.de`, Ziel `http://UNRAID-IP:8085`, SSL-Reiter: neues Let's-Encrypt-Zertifikat, „Force SSL“ aktivieren.

Variante B: ohne offene Ports per **Cloudflare Tunnel** oder **Tailscale** (mit `tailscale serve`/HTTPS).

## 5. Auf dem iPhone
In Safari die HTTPS-Adresse öffnen, Passwort eingeben, dann Teilen → „Zum Home-Bildschirm“. Manifest und Service Worker folgen in Stufe 2.


## Zugangscodes und Cache (persistente Daten)

Die App speichert Zugangscodes (`users.json`) und den Übersetzungs-Cache (`cache.db`) in `/data` im Container. Damit sie ein Update überleben, muss `/data` auf den Server gemappt sein. In der Compose-Datei (Compose Manager) beim Dienst ergänzen:

```yaml
    volumes:
      - /mnt/user/appdata/uebersetzer-pwa/data:/data
```

Ohne dieses Volume gehen Codes und Cache bei jedem Update verloren.

Zugänge anlegen: mit dem Hauptpasswort anmelden, Tab „Einstellungen“, „Zugänge verwalten“. Jede Person bekommt einen eigenen Code, den sie statt des Passworts eingibt. Sperren löscht den Code sofort.

## Push-Mitteilungen für Chats (optional)

Damit neue Chat-Nachrichten als Mitteilung (mit Zahl am App-Symbol) ankommen, braucht der Server einmalig ein eigenes Schlüsselpaar:

1. Bei laufendem Container im Unraid-Terminal:

       docker exec uebersetzer-pwa python -m backend.push

2. Die zwei ausgegebenen Zeilen (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) in die `.env` übernehmen. Der private Schlüssel gehört nur in die `.env`.
3. Container neu starten: `docker compose up -d`.
4. Auf jedem Handy: App vom Home-Bildschirm öffnen, Tab „Gespräch“ → „Chats“ → „Mitteilungen einschalten“ und erlauben. Auf dem iPhone geht das ab iOS 16.4 und nur in der App vom Home-Bildschirm, nicht in Safari.

Die Schlüssel gelten für den Server, nicht für ein Handy: Jede Person schaltet Mitteilungen auf ihrem eigenen Handy ein, iPhone und Android gemischt. Wer mehrere Geräte nutzt, bekommt die Mitteilung auf allen.

Als Kontaktangabe für Apple und Google („subject“) verwendet der Server automatisch die HTTPS-Adresse der App. Es werden keine Mails verschickt. Nur falls der Push-Dienst das ablehnt, kann man in der `.env` eine eigene Angabe setzen, z. B. `VAPID_SUBJECT=https://uebersetzer.example.de`.

Die Schlüssel nicht mehr ändern: Neue Schlüssel machen alle Anmeldungen ungültig, dann muss jedes Handy Mitteilungen neu einschalten.

Mitteilungen laufen über die Push-Dienste von Apple bzw. Google und enthalten Absender und Nachrichtentext (übersetzt in die Sprache des Empfängers).

