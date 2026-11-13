# DIY Mamis · 3D-Raumplaner (Prototyp)

Aus einem Video, Fotos oder einem Grundriss wird eine editierbare 3D-Szene eines Raums.
Im Browser kann man Möbel verschieben, drehen, löschen und hinzufügen, Wände und Möbel
umfärben, Wandpaneele setzen, den Raum leeren und echte Maße eintragen. Blender läuft
headless auf dem Server, baut die Szene und rendert auf Wunsch ein fotorealistisches Bild.

## Aufbau

```
Browser (WordPress-Seite)              VPS
┌──────────────────────────┐   HTTPS  ┌──────────────────────────────────────────┐
│ Editor (Three.js)        │ ───────► │ API (FastAPI)                            │
│  - zeigt scene.glb       │          │  ├─ KI-Analyse (Claude): Bilder → Szene  │
│  - ändert scene.json     │ ◄─────── │  ├─ Blender (bpy): Szene → .glb / .png   │
└──────────────────────────┘          │  └─ Dateien: data/projects/<id>/         │
                                      └──────────────────────────────────────────┘
```

- **`shared/catalog.json`**: Möbelkategorien mit Standardmaßen und -farben, Paneeltypen, Bodenarten.
- **`backend/app/scene.py`**: das Szenenformat (Raumkontur, Wände mit Fenstern/Türen/Paneelen,
  Boden, Decke, Möbel). Es ist die einzige Quelle der Wahrheit.
- **`backend/app/analysis.py`**: zieht Einzelbilder aus Videos (ffmpeg), schickt Bilder bzw.
  Grundriss an Claude und bekommt eine strukturierte Raumbeschreibung zurück.
- **`blender/build_scene.py`**: baut die Szene in Blender (Wände mit Aussparungen, Fenster,
  Türzargen, Lamellen-/Kassettenpaneele, parametrische Möbel) und exportiert glTF.
- **`backend/app/main.py`**: API für Upload, Status, Speichern (mit Neubau) und Rendern.
- **`web/`**: der Editor (TypeScript, Three.js, Vite).
- **`wordpress-plugin/`**: Plugin mit Shortcode `[diy_mamis_raumplaner]`.

Bearbeitungen wie Verschieben, Löschen, Umfärben und Raum leeren zeigt der Editor sofort an
und speichert im Hintergrund. Änderungen an der Geometrie (neue Möbel, Maße, Paneele,
Fenster/Türen) lässt er von Blender neu bauen, das dauert etwa eine Sekunde.

## Lokal starten

Voraussetzungen: Python 3.13, Node 22, ffmpeg.

```bash
# Backend mit Blender als Python-Modul
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

Blender direkt ausprobieren:

```bash
python blender/build_scene.py szene.json szene.glb --render bild.png
```

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
- Die KI-Analyse ist geschrieben, aber noch nicht mit echten Videos getestet (wartet auf den API-Key).

## Demo ohne Server

Der Editor kann eine fertige Szene auch ganz ohne Backend zeigen (z. B. als statische Seite).
Dann laufen Umsehen, Verschieben, Drehen, Löschen, Hinzufügen, Umfärben und „Raum leeren“ im
Browser. Maße, Fenster/Türen, Paneele und Live-Rendering brauchen weiterhin den Server.

```bash
python blender/build_scene.py szene.json demo/room.glb
python tools/build_library.py demo/library.glb
cp szene.json demo/scene.json && cp shared/catalog.json demo/catalog.json
```

```html
<div id="app" class="dm-fullpage" data-demo="demo/"></div>
```

Optional: `data-room` / `data-library` für andere Dateinamen, `data-render` für ein vorab gerendertes Bild.
