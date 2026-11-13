# DIY Mamis · 3D-Raumplaner (Prototyp)

Aus einem Video, Fotos oder einem Grundriss wird eine editierbare 3D-Szene eines Raums.
Im Browser kann man Möbel verschieben, drehen, löschen und hinzufügen, Wände und Möbel
umfärben, Wandpaneele setzen, den Raum leeren und echte Maße eintragen. Die 3D-Szene baut
der Editor selbst mit three.js, jede Änderung ist sofort sichtbar. Der Server übernimmt nur die
KI-Analyse und das Speichern.

## Aufbau

```
Browser (WordPress-Seite)              VPS
┌──────────────────────────┐   HTTPS  ┌──────────────────────────────────────────┐
│ Editor (Three.js)        │ ───────► │ API (FastAPI)                            │
│  - baut 3D aus der Szene │          │  ├─ KI-Analyse (Claude): Bilder → Szene  │
│  - ändert scene.json     │ ◄─────── │  ├─ Speichern der Szene                  │
└──────────────────────────┘          │  └─ Dateien: data/projects/<id>/         │
                                      └──────────────────────────────────────────┘
```

- **`shared/catalog.json`**: Möbelkategorien mit Standardmaßen und -farben, Paneeltypen, Bodenarten.
- **`backend/app/scene.py`**: das Szenenformat (Raumkontur, Wände mit Fenstern/Türen/Paneelen,
  Boden, Decke, Möbel). Es ist die einzige Quelle der Wahrheit.
- **`backend/app/analysis.py`**: zieht Einzelbilder aus Videos (ffmpeg), schickt Bilder bzw.
  Grundriss an Claude und bekommt eine strukturierte Raumbeschreibung zurück.
- **`web/src/build.ts`**: baut die Szene mit three.js (Wände mit Aussparungen, Fenster,
  Türzargen, Lamellen-/Kassettenpaneele, parametrische Möbel).
- **`backend/app/main.py`**: API für Upload, Status und Speichern.
- **`web/`**: der Editor (TypeScript, Three.js, Vite).
- **`wordpress-plugin/`**: Plugin mit Shortcode `[diy_mamis_raumplaner]`.

Alle Bearbeitungen zeigt der Editor sofort an und speichert im Hintergrund. Änderungen an der
Geometrie (neue Möbel, Maße, Paneele, Fenster/Türen) baut er in wenigen Millisekunden neu.

## Lokal starten

Voraussetzungen: Python 3.13, Node 22, ffmpeg.

```bash
# Backend
python3.13 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
export ANTHROPIC_API_KEY=...        # optional, ohne Key geht nur der Demo-Raum
# alternativ DM_ANTHROPIC_API_KEY=... (z.B. in Claude-Cloud-Umgebungen, die ANTHROPIC_API_KEY selbst belegen)

# Editor bauen
(cd web && npm ci && npm run build)

# Server: Editor + API auf http://localhost:8765
cd backend && uvicorn app.main:app --port 8765
```

Für die Entwicklung am Editor: `cd web && npm run dev` (leitet `/api` an Port 8765 weiter).

## Auf dem VPS

```bash
git clone <repo> && cd <repo>
cp .env.example .env    # Domain, API-Key, WordPress-Domain eintragen
docker compose up -d --build
```

Caddy holt das HTTPS-Zertifikat für die Subdomain automatisch. Der DNS-Eintrag der Subdomain
muss vorher auf den VPS zeigen. Daten liegen im Docker-Volume `data`.

## In WordPress einbinden

1. `wordpress-plugin/build.sh` ausführen, das erzeugt `wordpress-plugin/diy-mamis-3d.zip`.
2. In WordPress unter *Plugins → Installieren → Plugin hochladen* die ZIP-Datei hochladen und aktivieren.
3. Unter *Einstellungen → DIY Mamis Raumplaner* die Backend-Adresse eintragen (z. B. `https://app.example.de`).
4. Auf einer Seite den Shortcode `[diy_mamis_raumplaner]` einfügen.

## Stand und nächste Schritte

- Möbel sind vorerst parametrische Modelle (aus Kategorie, Maßen und Farbe gebaut).
  Echte Produkte (IKEA, Amazon) werden später über `product` an einem Möbelstück verknüpft;
  die Maße kommen dann aus dem Katalog des Händlers.
- Zugang: Wer den Projekt-Link kennt, kann das Projekt bearbeiten. Konten und Bezahlung
  folgen später über WordPress.
- Die KI-Analyse ist mit einem echten Küchenvideo getestet: Möbel und Anordnung stimmen gut,
  die Maße weichen um 10–15 % ab und werden im Editor korrigiert.
- Als Nächstes: fotorealistisches KI-Rendering der aktuellen Ansicht (Screenshot → Bildmodell).

## Demo ohne Server

Der Editor kann eine fertige Szene auch ganz ohne Backend zeigen (z. B. als statische Seite).
Dann läuft alles außer dem Hochladen neuer Räume im Browser; Änderungen werden nicht gespeichert.

```html
<div id="app" class="dm-fullpage" data-demo="demo/"></div>
```

Der Ordner `demo/` enthält `scene.json` und `catalog.json` (Kopie von `shared/catalog.json`).
Optional zeigt `data-render="bild.jpg"` ein vorab gerendertes Bild beim Klick auf „Foto-Rendering“.
