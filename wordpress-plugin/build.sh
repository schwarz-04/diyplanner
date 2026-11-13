#!/usr/bin/env bash
# Baut den Editor und packt das WordPress-Plugin als ZIP (wordpress-plugin/diy-mamis-3d.zip).
set -euo pipefail
cd "$(dirname "$0")/.."
(cd web && npm ci && npm run build)
rm -rf wordpress-plugin/diy-mamis-3d/assets
mkdir -p wordpress-plugin/diy-mamis-3d/assets
cp web/dist/assets/editor.js web/dist/assets/editor.css wordpress-plugin/diy-mamis-3d/assets/
(cd wordpress-plugin && rm -f diy-mamis-3d.zip && zip -qr diy-mamis-3d.zip diy-mamis-3d)
echo "Fertig: wordpress-plugin/diy-mamis-3d.zip"
