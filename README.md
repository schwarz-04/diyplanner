# DIY Mamis · 3D-Raumplaner (Prototyp)

Aus einem Video, Fotos oder einem Grundriss wird per KI ein editierbarer 3D-Raum.
Im Browser kann man sich im Raum umsehen, Möbel verschieben, drehen, löschen und hinzufügen,
Wände und Möbel umfärben, Stile anwenden, Wandpaneele, Fenster und Türen setzen, den Raum leeren,
echte Maße eintragen, Abstände messen, weitere Räume anbauen (leer oder aus einem eigenen Video)
und die Wohnung in der Ich-Perspektive durch die Türen begehen. Alles läuft als ein WordPress-Plugin, ein eigener Server ist nicht nötig.

## Aufbau

```
Browser (WordPress-Seite mit Shortcode)            WordPress (Plugin)              Claude-API
┌─────────────────────────────────────┐   REST   ┌─────────────────────────┐   HTTPS   ┌────────┐
│ Editor (three.js)                   │ ───────► │ /wp-json/dm3d/v1/api/…  │ ────────► │ Claude │
│  - schneidet Einzelbilder aus Video │          │  - KI-Analyse anstoßen  │ ◄──────── │        │
│  - baut die 3D-Szene selbst         │ ◄─────── │  - Szene speichern      │           └────────┘
│  - KI-Antwort → Szene               │          │  - uploads/dm3d-projekte│
└─────────────────────────────────────┘          └─────────────────────────┘
```

- **`web/`**: der Editor (TypeScript, three.js, Vite).
  - `src/build.ts` baut die 3D-Szene (Wände mit Aussparungen, Fenster, Türen,
    Lamellen-/Kassettenpaneele, parametrische Möbel). Jede Änderung ist sofort sichtbar.
  - `src/analysis.ts` schneidet Einzelbilder aus dem Video (Canvas), verkleinert Fotos und
    wandelt die KI-Antwort in eine Szene um.
  - `src/app.ts` Oberfläche mit der Menüleiste unten (Ansicht, Raum, Auswahl, Entfernen, Farbe, Möbel, Style).
  - `src/measure.ts` Raummaße, Möbelmaße und Wandabstände, freies Messen.
  - `src/walk.ts` Begehen (W/A/S/D bzw. Joystick am Handy, mit Kollision an Wänden und Möbeln).
  - `src/showcase.ts` animierter Beispielraum als Hintergrund der Startseite.
  - `src/home.ts` Wohnung aus mehreren Räumen: Räume anbauen (mit Tür in beiden Wänden), Grundriss zum Begehen.
  - `src/types.ts` ist das Szenenformat. Version 1 ist ein Raum, Version 2 eine Wohnung
    (`rooms[]` mit `position`, `rotation` und der Szene des Raums). Alte Projekte werden beim Öffnen umgewandelt.
- **`wordpress-plugin/diy-mamis-3d/`**: das Plugin.
  - `includes/rest.php` REST-Schnittstelle, `includes/store.php` Ablage der Projekte,
    `includes/claude.php` Aufruf der Claude-API (über die WordPress-HTTP-API, damit das Plugin
    ohne Composer-Abhängigkeiten auskommt).
- **`shared/`**: Möbelkatalog, Demo-Raum, Prompt und Antwortschema der KI-Analyse.
  `build.sh` kopiert sie ins Plugin.

Ablauf einer Analyse: Der Browser schneidet 16 Einzelbilder aus dem Video und lädt nur diese
hoch (etwa 2 MB statt des ganzen Videos). WordPress schickt sie an Claude und speichert die
strukturierte Raumbeschreibung. Der Editor baut daraus die Szene und speichert sie.

## Plugin bauen und installieren

Voraussetzung zum Bauen: Node 22.

```bash
wordpress-plugin/build.sh      # erzeugt wordpress-plugin/diy-mamis-3d.zip
```

1. In WordPress unter *Plugins → Installieren → Plugin hochladen* die ZIP-Datei hochladen und aktivieren.
2. Unter *Einstellungen → DIY Mamis Raumplaner* den Anthropic-API-Key eintragen
   (oder in der `wp-config.php`: `define('DM3D_ANTHROPIC_API_KEY', '…');`).
3. Auf einer Seite den Shortcode `[diy_mamis_raumplaner]` einfügen. Die Seite zeigt dann nur den
   Raumplaner, bildschirmfüllend und ohne Kopfzeile, Menü und Hintergrund des Themes; oben links
   führt ein Link zurück zur Webseite. Soll er stattdessen in der normalen Seite stehen:
   `[diy_mamis_raumplaner ansicht="seite"]`, optional mit `hoehe="800px"` und `breite="voll"`.

4. Optional unter *Raumplaner-Produkte* eigene Produktempfehlungen anlegen (Link zu IKEA, Amazon
   oder einem anderen Shop, Maße, Farbe, Bild-Adresse, Preis, Art des 3D-Modells). Nutzer setzen sie im
   Raumplaner unter „Möbel“ in echter Größe ein; die Einkaufsliste sammelt alle verlinkten Produkte mit
   Summe. In den Einstellungen eingetragen, wird der Amazon-Partner-Tag an alle Amazon-Links gehängt.
   Nutzer können außerdem eigene Produkte per Link einfügen und die Maße selbst eintragen.

   Viele Produkte auf einmal: *Raumplaner-Produkte → Tabelle importieren* nimmt eine Excel- (.xlsx) oder
   CSV-Datei mit den Spalten `Kategorie, Produktname, Produktlink, Höhe (cm), Breite (cm), Tiefe (cm),
   Farbvarianten, Bild-URL` (optional `Preis`). Die Kategorie wählt das 3D-Modell (z. B. Sofa, Regal,
   Wandregal, Tischlampe), Farbnamen werden in Farbtöne übersetzt (eigene mit `Salbei #a9b9a6`).
   Gibt es mehrere Farbvarianten, wählen Nutzer sie im Raumplaner aus. Gleicher Produktlink = Update.
   Steht in der Kategorie ein Sammelbegriff (Regal, Möbel, Deko), wählt der Import das 3D-Modell aus dem
   Produktnamen; im Möbel-Menü erscheinen die Produkte unter Regale / Möbel / Deko, filterbar nach Shop.

5. Projekte: Änderungen werden laufend gesichert. Über „Speichern“ bekommt ein Projekt Namen und
   Vorschaubild, unter „Projekte“ lassen sich alle wieder öffnen, umbenennen, kopieren oder löschen.
   Angemeldete Nutzer sehen ihre Projekte auf jedem Gerät, ohne Anmeldung merkt sie sich der Browser.

Neue Räume können standardmäßig nur angemeldete Nutzer anlegen, weil jede Analyse KI-Guthaben
kostet (grob 15–30 Cent). Das lässt sich in den Einstellungen abschalten. Bearbeiten kann jeder,
der den Projekt-Link kennt.

Anforderungen an den Webspace: PHP 7.4+, ausgehende HTTPS-Verbindungen, ein PHP-Zeitlimit von
mindestens 2 Minuten für die Analyse (das Plugin versucht es selbst zu erhöhen) und
`post_max_size` von mindestens 8 MB.

## Editor entwickeln

```bash
cd web && npm ci && npm run dev
```

Der Editor braucht für Projekte die REST-Schnittstelle des Plugins (`data-api` am Container).
Ohne Server läuft er im Demo-Modus:

```html
<div id="app" class="dm-fullpage" data-demo="demo/"></div>
```

Der Ordner `demo/` enthält `scene.json` und `catalog.json` (Kopie von `shared/catalog.json`).
Optional zeigt `data-render="bild.jpg"` ein vorab gerendertes Bild beim Klick auf „Foto-Rendering“.

## Stand und nächste Schritte

- Die KI-Analyse ist mit einem echten Küchenvideo getestet: Möbel und Anordnung stimmen gut,
  die Maße weichen um 10–15 % ab und werden im Editor korrigiert.
- Videos werden im Browser gelesen. iPhone-Videos im HEVC-Format kann nicht jeder Browser
  öffnen (Safari ja, Chrome je nach Gerät); dann hilft „Kompatibel“ in den iPhone-Kamera-Einstellungen.
- Möbel sind parametrische Modelle (aus Kategorie, Maßen und Farbe gebaut). Echte Produkte
  (IKEA, Amazon) werden später über `product` verknüpft.
- Als Nächstes: fotorealistisches KI-Rendering der aktuellen Ansicht (Screenshot → Bildmodell).
