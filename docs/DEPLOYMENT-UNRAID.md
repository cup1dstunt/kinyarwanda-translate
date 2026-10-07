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
