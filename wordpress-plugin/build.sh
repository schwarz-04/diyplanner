#!/usr/bin/env bash
# Baut den Editor und packt das WordPress-Plugin als ZIP (wordpress-plugin/diy-mamis-3d.zip).
set -euo pipefail
cd "$(dirname "$0")/.."
(cd web && npm ci && npm run build)
P=wordpress-plugin/diy-mamis-3d
rm -rf "$P/assets" "$P/data"
mkdir -p "$P/assets" "$P/data"
cp web/dist/assets/editor.js web/dist/assets/editor.css "$P/assets/"
cp shared/catalog.json shared/demo-scene.json shared/demo-home.json shared/analysis-prompt.txt shared/room-analysis.schema.json shared/apartment-prompt.txt shared/apartment-analysis.schema.json "$P/data/"
(cd wordpress-plugin && rm -f diy-mamis-3d.zip && zip -qr diy-mamis-3d.zip diy-mamis-3d)
echo "Fertig: wordpress-plugin/diy-mamis-3d.zip"
