<?php
/**
 * Import der Produkttabelle (CSV oder Excel .xlsx) unter „Raumplaner-Produkte → Tabelle importieren“.
 *
 * Erkannte Spalten (Groß-/Kleinschreibung und Zusätze wie „(cm)“ egal):
 *   Kategorie, Produktname, Produktlink, Höhe, Breite, Tiefe, Farbvarianten, Bild-URL, Preis
 * Andere Spalten (z. B. „Bild-Vorschau“) werden übersprungen.
 * Ein vorhandenes Produkt mit demselben Produktlink (sonst demselben Namen) wird aktualisiert.
 */

if (!defined('ABSPATH')) {
    exit;
}

class DM3D_Import
{
    const COLUMNS = [
        'category' => ['kategorie', 'category', 'art', 'typ'],
        'name' => ['produktname', 'name', 'produkt', 'bezeichnung', 'titel'],
        'url' => ['produktlink', 'link', 'url', 'produkt-url', 'produkturl'],
        'height' => ['höhe', 'hoehe', 'height', 'h'],
        'width' => ['breite', 'width', 'b'],
        'depth' => ['tiefe', 'depth', 't', 'länge', 'laenge'],
        'variants' => ['farbvarianten', 'farben', 'farbe', 'farbvariante', 'colors', 'color'],
        'image' => ['bild-url', 'bildurl', 'bild url', 'image', 'image url', 'bild-link', 'bildlink'],
        'price' => ['preis', 'price', 'preis €', 'preis eur'],
    ];

    /** Deutsche Bezeichnungen -> 3D-Modell (Schlüssel aus catalog.json). Reihenfolge: spezifisch vor allgemein. */
    const CATEGORY_WORDS = [
        'wandregal' => 'wall_shelf', 'schweberegal' => 'wall_shelf', 'bücherregal' => 'shelf', 'regal' => 'shelf',
        'beistelltisch' => 'side_table', 'couchtisch' => 'coffee_table', 'sofatisch' => 'coffee_table',
        'schreibtisch' => 'desk', 'esstisch' => 'dining_table', 'nachttisch' => 'nightstand', 'tisch' => 'dining_table',
        'tischlampe' => 'table_lamp', 'tischleuchte' => 'table_lamp', 'pendelleuchte' => 'pendant', 'hängelampe' => 'pendant',
        'hängeleuchte' => 'pendant', 'deckenleuchte' => 'pendant', 'deckenlampe' => 'pendant', 'stehlampe' => 'lamp',
        'stehleuchte' => 'lamp', 'lampe' => 'lamp', 'leuchte' => 'lamp',
        'kleiderschrank' => 'wardrobe', 'schrank' => 'wardrobe', 'kommode' => 'dresser', 'sideboard' => 'sideboard',
        'lowboard' => 'sideboard', 'tv-bank' => 'sideboard', 'tv-möbel' => 'sideboard', 'fernseher' => 'tv',
        'sofa' => 'sofa', 'couch' => 'sofa', 'sessel' => 'armchair', 'stuhl' => 'chair', 'hocker' => 'pouf',
        'pouf' => 'pouf', 'bett' => 'bed', 'teppich' => 'rug', 'läufer' => 'rug',
        'kissen' => 'cushion', 'decke' => 'cushion', 'vase' => 'vase', 'korb' => 'basket', 'aufbewahrung' => 'basket',
        'bilderrahmen' => 'picture', 'rahmen' => 'picture', 'poster' => 'picture', 'bild' => 'picture', 'wandbild' => 'picture',
        'spiegel' => 'mirror', 'vorhang' => 'curtain', 'gardine' => 'curtain', 'pflanze' => 'plant', 'kunstpflanze' => 'plant',
        'gewürzregal' => 'wall_shelf', 'eckregal' => 'shelf', 'aufsatzregal' => 'shelf', 'regaleinsatz' => 'shelf',
        'tv-bank' => 'sideboard', 'tv bank' => 'sideboard', 'unterschrank' => 'sideboard', 'wickeltisch' => 'dresser',
        'federholzrahmen' => 'box', 'lattenrost' => 'box', 'deckplatte' => 'box', 'tür' => 'box', 'matratze' => 'box',
        'kerzenhalter' => 'vase', 'kerzenständer' => 'vase', 'blumentopf' => 'vase', 'blumentöpfe' => 'vase', 'übertopf' => 'vase',
        'pflanzkübel' => 'vase', 'gewächshaus' => 'box', 'fußmatte' => 'rug', 'matte' => 'rug', 'körbe' => 'basket',
        'fotorahmen' => 'picture', 'frame' => 'picture', 'blätter' => 'plant', 'tischleuchtenfuß' => 'table_lamp',
        'deko' => 'box',
    ];

    /** Sammelbegriffe in der Spalte Kategorie: Modell dann aus dem Produktnamen, nur aus diesen Gruppen. */
    const GENERIC = [
        'regal' => 'shelf', 'regale' => 'shelf', 'möbel' => 'furniture', 'moebel' => 'furniture',
        'deko' => 'deko', 'dekoration' => 'deko', 'accessoires' => 'deko', 'wohnaccessoires' => 'deko',
    ];

    /** Farb- und Materialnamen -> Farbton. Längere Namen zuerst prüfen. */
    const COLORS = [
        'weiß' => '#f2f0eb', 'weiss' => '#f2f0eb', 'cremeweiß' => '#efe9df', 'creme' => '#efe6d6', 'offwhite' => '#efe9df',
        'schwarz' => '#2b2b2b', 'anthrazit' => '#3e4144', 'dunkelgrau' => '#5c5f63', 'hellgrau' => '#c9c9c6', 'grau' => '#8a8f98',
        'beige' => '#d9cbb5', 'sand' => '#d8c7a8', 'taupe' => '#a59684', 'greige' => '#b9b1a5', 'natur' => '#d8c3a0',
        'braun' => '#7a5c43', 'dunkelbraun' => '#4a3428', 'cognac' => '#9a5b2e', 'karamell' => '#b07a45',
        'eiche' => '#c9a57a', 'eichenfurnier' => '#c9a57a', 'buche' => '#d4a77a', 'birke' => '#e0c9a6', 'kiefer' => '#d9b98a',
        'nussbaum' => '#6e4b33', 'walnuss' => '#6e4b33', 'teak' => '#9a6b43', 'akazie' => '#a8774a', 'bambus' => '#d6bf8c',
        'rattan' => '#c9a26b', 'jute' => '#c4a77d', 'holz' => '#b48a60', 'mango' => '#a8774a',
        'salbei' => '#a9b9a6', 'salbeigrün' => '#a9b9a6', 'olivgrün' => '#6b7046', 'oliv' => '#6b7046', 'dunkelgrün' => '#2f4a3a',
        'grün' => '#4f7a46', 'mint' => '#b7d3c3',
        'hellblau' => '#a9b8c6', 'dunkelblau' => '#24364f', 'navy' => '#24364f', 'petrol' => '#2f5d62', 'türkis' => '#4aa3a2', 'blau' => '#3d5a80',
        'terrakotta' => '#c0694a', 'terracotta' => '#c0694a', 'rost' => '#a5532d', 'rot' => '#a83a32', 'bordeaux' => '#6b2232',
        'altrosa' => '#d8b8a8', 'rosa' => '#e6b8c0', 'pink' => '#d97a9a', 'senf' => '#c9a227', 'gelb' => '#e3c35a', 'orange' => '#d9813a',
        'gold' => '#c9a227', 'messing' => '#b8954a', 'kupfer' => '#b87333', 'silber' => '#c0c0c0', 'chrom' => '#d0d4d8',
        'edelstahl' => '#b9bcbf', 'glas' => '#cfe6f2', 'transparent' => '#e6eef2', 'marmor' => '#e8e5e0', 'beton' => '#9b9b98',
        'weiß lasiert' => '#e3d8c6', 'eicheneff wlas' => '#dcc9ab', 'eicheneffekt weiß lasiert' => '#dcc9ab', 'wlas' => '#dcc9ab',
        'braun nussbaum' => '#6e4b33', 'eiche dunkel' => '#7a5a3c', 'dunkle eiche' => '#7a5a3c',
        'blasslila' => '#cbbfd8', 'blassrosa' => '#ecd2d0', 'hellgrün' => '#a9c79c', 'graublau' => '#5f6f80', 'blush' => '#e3b9b0',
        'vernickelt' => '#b9bcbf', 'nickel' => '#b9bcbf', 'durchsichtig' => '#e6eef2', 'farblos' => '#e6eef2', 'klarglas' => '#e6eef2', 'klar' => '#e6eef2',
        'lila' => '#8e6c9e', 'violett' => '#7a5a95', 'flieder' => '#c3b1d6', 'lavendel' => '#b9a8d1', 'bunt' => '#c98f6a', 'mehrfarbig' => '#c98f6a',
    ];

    public static function init(): void
    {
        add_action('admin_menu', function () {
            add_submenu_page('edit.php?post_type=' . DM3D_Products::TYPE, 'Tabelle importieren', 'Tabelle importieren',
                'edit_posts', 'dm3d-import', [self::class, 'page']);
        });
    }

    public static function page(): void
    {
        $report = null;
        if (isset($_POST['dm3d_import_nonce']) && wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['dm3d_import_nonce'])), 'dm3d_import')
            && !empty($_FILES['dm3d_file']['tmp_name'])) {
            $report = self::import((string) $_FILES['dm3d_file']['tmp_name'], (string) ($_FILES['dm3d_file']['name'] ?? ''));
        }
        ?>
        <div class="wrap">
            <h1>Produkttabelle importieren</h1>
            <?php if ($report) : ?>
                <div class="notice <?php echo $report['error'] ? 'notice-error' : 'notice-success'; ?>"><p>
                    <?php echo esc_html($report['error'] ?: sprintf('%d Produkte neu angelegt, %d aktualisiert.', $report['created'], $report['updated'])); ?>
                </p></div>
                <?php if ($report['warnings']) : ?>
                    <div class="notice notice-warning"><p><strong>Bitte prüfen:</strong></p><ul style="list-style:disc;margin-left:20px">
                        <?php foreach (array_slice($report['warnings'], 0, 100) as $w) echo '<li>' . esc_html($w) . '</li>'; ?>
                    </ul></div>
                <?php endif; ?>
            <?php endif; ?>
            <p>Lade deine Produkttabelle als <strong>Excel-Datei (.xlsx)</strong> oder <strong>CSV</strong> hoch. Die erste Zeile enthält die Spaltennamen:</p>
            <p><code>Kategorie · Produktname · Produktlink · Höhe (cm) · Breite (cm) · Tiefe (cm) · Farbvarianten · Bild-URL</code>, optional <code>Preis</code>.
                Weitere Spalten wie „Bild-Vorschau“ werden übersprungen.</p>
            <ul style="list-style:disc;margin-left:20px">
                <li><strong>Kategorie</strong> bestimmt das 3D-Modell, z. B. Sofa, Sessel, Regal, Wandregal, Kommode, Couchtisch, Teppich, Kissen, Vase, Korb, Bilderrahmen, Spiegel, Vorhang, Pendelleuchte, Tischlampe.</li>
                <li><strong>Farbvarianten</strong> mit Komma trennen, z. B. <code>weiß, Eiche, schwarz</code>. Zweifarbige Varianten wie <code>weiß/Eiche</code> bleiben eine Variante. Eigene Farbtöne gehen so: <code>Salbei #a9b9a6</code>. Die erste Variante ist die Standardfarbe.</li>
                <li>Produkte mit demselben Produktlink werden aktualisiert, nicht doppelt angelegt. Du kannst die Tabelle also jederzeit erneut hochladen.</li>
            </ul>
            <form method="post" enctype="multipart/form-data">
                <?php wp_nonce_field('dm3d_import', 'dm3d_import_nonce'); ?>
                <p><input type="file" name="dm3d_file" accept=".xlsx,.csv,.txt" required></p>
                <?php submit_button('Importieren'); ?>
            </form>
        </div>
        <?php
    }

    /** @return array{created:int,updated:int,warnings:string[],error:string} */
    public static function import(string $path, string $filename): array
    {
        $report = ['created' => 0, 'updated' => 0, 'warnings' => [], 'error' => ''];
        $rows = strtolower(pathinfo($filename, PATHINFO_EXTENSION)) === 'xlsx' ? self::read_xlsx($path) : self::read_csv($path);
        if ($rows === null || count($rows) < 2) {
            $report['error'] = 'Die Datei konnte nicht gelesen werden oder enthält keine Produkte.';
            return $report;
        }
        $map = self::map_header(array_shift($rows));
        if (!isset($map['name'])) {
            $report['error'] = 'Spalte „Produktname“ nicht gefunden. Bitte die Spaltennamen in der ersten Zeile prüfen.';
            return $report;
        }
        $catalog = json_decode((string) file_get_contents(DM3D_DIR . 'data/catalog.json'), true)['categories'] ?? [];
        foreach ($rows as $i => $row) {
            $line = $i + 2;
            $get = function ($k) use ($map, $row) {
                return isset($map[$k]) ? trim((string) ($row[$map[$k]] ?? '')) : '';
            };
            $name = $get('name');
            if ($name === '') continue;
            $url = esc_url_raw($get('url'));
            $category = self::category($get('category'), $name, $catalog);
            if ($category === null) {
                $report['warnings'][] = "Zeile $line ($name): Kein passendes 3D-Modell gefunden, als einfacher Quader dargestellt.";
                $category = 'box';
            }
            // Ohne Farbvarianten: Farbe aus dem Produktnamen („IVAR Schrank – Kiefer“), sonst Standardfarbe des Modells
            $fallback = self::color_for(self::norm($name)) ?? ($catalog[$category]['color'] ?? '#c9b8a0');
            $variants = self::variants($get('variants'), $fallback, $unknown);
            foreach ($unknown as $u) $report['warnings'][] = "Zeile $line ($name): Farbe „{$u}“ unbekannt, bitte mit Farbcode angeben (z. B. „{$u} #a9b9a6“).";

            $id = self::find($url, $name);
            $data = ['post_type' => DM3D_Products::TYPE, 'post_title' => $name, 'post_status' => 'publish'];
            if ($id) {
                $data['ID'] = $id;
                wp_update_post($data);
                $report['updated']++;
            } else {
                $id = wp_insert_post($data);
                if (!$id || is_wp_error($id)) continue;
                $report['created']++;
            }
            [$width, $depth, $height] = self::dims($category, $catalog, self::number($get('width')), self::number($get('depth')), self::number($get('height')));
            $meta = [
                'url' => $url,
                'image' => esc_url_raw($get('image')),
                'category' => $category,
                'width' => $width,
                'depth' => $depth,
                'height' => $height,
                'color' => $variants[0]['color'] ?? '',
                'variants' => wp_slash(wp_json_encode($variants, JSON_UNESCAPED_UNICODE)),
            ];
            if (isset($map['price'])) $meta['price'] = self::number($get('price'));
            foreach ($meta as $k => $v) update_post_meta($id, '_dm3d_' . $k, $v);
            $expected_empty = ($category === 'rug' && !$meta['height']) || (($catalog[$category]['mount'] ?? '') === 'wall' && !$meta['depth']);
            if ((!$meta['width'] || !$meta['depth'] || !$meta['height']) && !$expected_empty) {
                $report['warnings'][] = "Zeile $line ($name): Maße unvollständig, fehlende Werte kommen aus dem Standardmodell.";
            }
        }
        return $report;
    }

    private static function find(string $url, string $name): int
    {
        if ($url !== '') {
            $ids = get_posts(['post_type' => DM3D_Products::TYPE, 'post_status' => 'any', 'fields' => 'ids', 'numberposts' => 1,
                'meta_key' => '_dm3d_url', 'meta_value' => $url]);
            if ($ids) return (int) $ids[0];
        }
        $q = new WP_Query(['post_type' => DM3D_Products::TYPE, 'post_status' => 'any', 'title' => $name, 'fields' => 'ids', 'posts_per_page' => 1]);
        return $q->posts ? (int) $q->posts[0] : 0;
    }

    private static function norm(string $s): string
    {
        $s = mb_strtolower(trim($s));
        $s = preg_replace('/\(.*?\)|\bin\s+(cm|€|eur)\b/u', '', $s);
        return trim(preg_replace('/\s+/u', ' ', $s));
    }

    private static function map_header(array $header): array
    {
        $map = [];
        foreach ($header as $idx => $h) {
            $n = self::norm((string) $h);
            foreach (self::COLUMNS as $key => $names) {
                if (!isset($map[$key]) && in_array($n, $names, true)) {
                    $map[$key] = $idx;
                    break;
                }
            }
        }
        return $map;
    }

    private static function category(string $value, string $name, array $catalog): ?string
    {
        $v = self::norm($value);
        if ($v !== '' && !isset(self::GENERIC[$v])) {
            if (isset($catalog[$v])) return $v;
            foreach ($catalog as $key => $c) {
                if (mb_strtolower($c['label']) === $v) return $key;
            }
            $hit = self::find_word($v, null, $catalog);
            if ($hit !== null) return $hit;
        }
        // Sammelbegriff (Regal, Möbel, Deko) oder leer: Modell aus dem Produktnamen
        $group = self::GENERIC[$v] ?? null;
        $hit = self::find_word(self::norm($name), $group, $catalog);
        if ($hit !== null) return $hit;
        return ['shelf' => 'shelf'][$group] ?? null;
    }

    /** Erstes Stichwort im Text (bei gleicher Stelle das längere), passend zur Gruppe. */
    private static function find_word(string $text, ?string $group, array $catalog): ?string
    {
        $deko_extra = ['rug', 'plant', 'lamp', 'box'];
        $best = null;
        foreach (self::CATEGORY_WORDS as $word => $key) {
            $pos = mb_strpos($text, $word);
            if ($pos === false) continue;
            $is_deko = ($catalog[$key]['group'] ?? '') === 'deko';
            if ($group === 'shelf' && !in_array($key, ['shelf', 'wall_shelf', 'box'], true)) continue;
            if ($group === 'furniture' && $is_deko) continue;
            if ($group === 'deko' && !$is_deko && !in_array($key, $deko_extra, true)) continue;
            if ($best === null || $pos < $best[0] || ($pos === $best[0] && mb_strlen($word) > $best[1])) $best = [$pos, mb_strlen($word), $key];
        }
        return $best[2] ?? null;
    }

    /**
     * Fehlende Maße sinnvoll ergänzen:
     * Teppich ohne Tiefe: „Höhe × Breite“ ist die Fläche. Bild/Spiegel ohne Breite: rund/quadratisch.
     * Sonst ohne Tiefe oder Breite: rundes/quadratisches Teil, der andere Wert wird übernommen.
     */
    private static function dims(string $cat, array $catalog, string $w, string $d, string $h): array
    {
        $wall = ($catalog[$cat]['mount'] ?? '') === 'wall';
        if ($cat === 'rug' && $d === '' && $h !== '') {
            [$d, $h] = [$h, ''];
        } elseif ($wall) {
            if ($w === '' && $h !== '') $w = $h;
        } elseif (in_array($cat, ['vase', 'basket', 'table_lamp', 'pendant', 'plant', 'pouf', 'side_table', 'lamp', 'cushion'], true)) {
            // rundes Teil: Breite = Tiefe
            if ($d === '' && $w !== '') $d = $w;
            if ($w === '' && $d !== '') $w = $d;
        }
        return [$w, $d, $h];
    }

    /** Für das Formular im Produkt: unbekannte Farben bekommen die Ersatzfarbe. */
    public static function parse_variants(string $value, string $fallback): array
    {
        $list = self::variants($value, $fallback, $unknown);
        return count($list) === 1 && $list[0]['name'] === 'Standard' ? [] : $list;
    }

    /** „weiß, Eiche, Salbei #a9b9a6“ -> [{name, color}] */
    private static function variants(string $value, string $fallback, &$unknown): array
    {
        $unknown = [];
        $out = [];
        // „Farben: Weiß, Eiche | Größen/Varianten: …“ -> nur der Farbteil
        if (strpos($value, '|') !== false) {
            $parts = array_map('trim', explode('|', $value));
            $value = $parts[0];
            foreach ($parts as $p) {
                if (preg_match('/^farben?\s*:/iu', $p)) { $value = $p; break; }
            }
        }
        $value = preg_replace('/^\s*farben?\s*:\s*/iu', '', $value);
        foreach (preg_split('/\s*[,;|\n]\s*/u', $value) ?: [] as $part) {
            $part = trim($part);
            if ($part === '') continue;
            $color = null;
            if (preg_match('/#([0-9a-f]{6}|[0-9a-f]{3})\b/i', $part, $m)) {
                $color = '#' . strtolower($m[1]);
                $part = trim(preg_replace('/\(?\s*#[0-9a-f]{3,6}\s*\)?/i', '', $part)) ?: $color;
            } else {
                $color = self::color_for($part);
                if ($color === null) {
                    $unknown[] = $part;
                    $color = $fallback;
                }
            }
            $out[] = ['name' => $part, 'color' => $color];
        }
        return $out ?: [['name' => 'Standard', 'color' => $fallback]];
    }

    private static function color_for(string $name): ?string
    {
        $n = mb_strtolower($name);
        if (isset(self::COLORS[$n])) return self::COLORS[$n];
        // Zuerst genannte Farbe gewinnt („weiß/Eiche“ -> weiß), bei gleicher Stelle der längere Name
        $best = null;
        foreach (self::COLORS as $k => $hex) {
            $pos = mb_strpos($n, $k);
            if ($pos === false) continue;
            if ($best === null || $pos < $best[0] || ($pos === $best[0] && mb_strlen($k) > $best[1])) $best = [$pos, mb_strlen($k), $hex];
        }
        return $best[2] ?? null;
    }

    private static function number(string $v): string
    {
        $v = str_replace([' ', '€', 'cm'], '', $v);
        if ($v === '') return '';
        // 1.234,56 -> 1234.56 ; 12,5 -> 12.5
        if (strpos($v, ',') !== false) $v = str_replace(['.', ','], ['', '.'], $v);
        return is_numeric($v) ? (string) max(0, (float) $v) : '';
    }

    // ------------------------------------------------------------------ Dateien lesen

    private static function read_csv(string $path): ?array
    {
        $raw = (string) file_get_contents($path);
        if ($raw === '') return null;
        $raw = preg_replace('/^\xEF\xBB\xBF/', '', $raw);
        if (!mb_check_encoding($raw, 'UTF-8')) $raw = mb_convert_encoding($raw, 'UTF-8', 'Windows-1252');
        $first = strtok($raw, "\n");
        $delims = ["\t" => substr_count($first, "\t"), ';' => substr_count($first, ';'), ',' => substr_count($first, ',')];
        arsort($delims);
        $delim = (string) array_key_first($delims);
        $fh = fopen('php://temp', 'r+');
        fwrite($fh, $raw);
        rewind($fh);
        $rows = [];
        while (($r = fgetcsv($fh, 0, $delim, '"', '\\')) !== false) {
            if ($r !== [null]) $rows[] = $r;
        }
        fclose($fh);
        return $rows;
    }

    /** Erstes Tabellenblatt einer .xlsx-Datei (ohne Zusatzbibliotheken). */
    private static function read_xlsx(string $path): ?array
    {
        if (!class_exists('ZipArchive')) return null;
        $zip = new ZipArchive();
        if ($zip->open($path) !== true) return null;
        $shared = [];
        $ss = $zip->getFromName('xl/sharedStrings.xml');
        if ($ss !== false) {
            $x = simplexml_load_string($ss);
            foreach ($x->si ?? [] as $si) {
                $text = '';
                if (isset($si->t)) $text = (string) $si->t;
                foreach ($si->r ?? [] as $r) $text .= (string) $r->t;
                $shared[] = $text;
            }
        }
        $sheet = $zip->getFromName('xl/worksheets/sheet1.xml');
        if ($sheet === false) {
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $n = $zip->getNameIndex($i);
                if (strpos($n, 'xl/worksheets/sheet') === 0) { $sheet = $zip->getFromName($n); break; }
            }
        }
        $zip->close();
        if ($sheet === false) return null;
        $x = simplexml_load_string($sheet);
        $rows = [];
        foreach ($x->sheetData->row ?? [] as $row) {
            $cells = [];
            foreach ($row->c as $c) {
                $ref = (string) $c['r'];
                $col = self::col_index(preg_replace('/\d+/', '', $ref));
                $t = (string) $c['t'];
                if ($t === 's') $v = $shared[(int) $c->v] ?? '';
                elseif ($t === 'inlineStr') $v = (string) ($c->is->t ?? '');
                else $v = (string) $c->v;
                $cells[$col] = $v;
            }
            if (!$cells) continue;
            $line = array_fill(0, max(array_keys($cells)) + 1, '');
            foreach ($cells as $k => $v) $line[$k] = $v;
            $rows[] = $line;
        }
        return $rows;
    }

    private static function col_index(string $letters): int
    {
        $n = 0;
        foreach (str_split(strtoupper($letters)) as $ch) $n = $n * 26 + (ord($ch) - 64);
        return $n - 1;
    }
}
