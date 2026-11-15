<?php
/**
 * Produktliste: eigene Empfehlungen (IKEA, Amazon, andere Shops), die Nutzer im Raumplaner
 * in echter Größe einsetzen können. Gepflegt im WordPress-Admin unter „Raumplaner-Produkte“.
 *
 * Gespeichert als eigener Beitragstyp dm3d_produkt; Titel = Produktname, Felder als Meta-Daten.
 * Amazon-Links bekommen automatisch den Partner-Tag aus den Einstellungen.
 */

if (!defined('ABSPATH')) {
    exit;
}

class DM3D_Products
{
    const TYPE = 'dm3d_produkt';
    const OPT_AMAZON_TAG = 'dm3d_amazon_tag';

    /** Meta-Felder: Schlüssel => [Bezeichnung, Typ] */
    const FIELDS = [
        'url' => ['Produkt-Link (IKEA, Amazon …)', 'url'],
        'image' => ['Bild-Adresse (URL)', 'url'],
        'price' => ['Preis in €', 'number'],
        'category' => ['Art (3D-Modell)', 'category'],
        'group' => ['Bereich im Möbel-Menü', 'group'],
        'width' => ['Breite in cm', 'number'],
        'depth' => ['Tiefe in cm', 'number'],
        'height' => ['Höhe in cm', 'number'],
        'color' => ['Farbe', 'color'],
        'variants' => ['Farbvarianten', 'variants'],
    ];

    public static function init(): void
    {
        add_action('init', [self::class, 'register_type']);
        add_action('add_meta_boxes', function () {
            add_meta_box('dm3d_product', 'Produktdaten für den Raumplaner', [self::class, 'meta_box'], self::TYPE, 'normal', 'high');
        });
        add_action('save_post_' . self::TYPE, [self::class, 'save'], 10, 2);
        add_filter('manage_' . self::TYPE . '_posts_columns', function ($cols) {
            return array_slice($cols, 0, 2) + ['dm3d_shop' => 'Shop', 'dm3d_size' => 'Maße (cm)', 'dm3d_price' => 'Preis'] + $cols;
        });
        add_action('manage_' . self::TYPE . '_posts_custom_column', function ($col, $id) {
            $p = self::product($id);
            if ($col === 'dm3d_shop') echo esc_html(ucfirst($p['source']));
            if ($col === 'dm3d_size') echo esc_html(round($p['size'][0] * 100) . ' × ' . round($p['size'][1] * 100) . ' × ' . round($p['size'][2] * 100));
            if ($col === 'dm3d_price') echo $p['price'] !== null ? esc_html(number_format_i18n($p['price'], 2) . ' €') : '–';
        }, 10, 2);
    }

    public static function register_type(): void
    {
        register_post_type(self::TYPE, [
            'labels' => [
                'name' => 'Raumplaner-Produkte',
                'singular_name' => 'Produkt',
                'add_new' => 'Produkt hinzufügen',
                'add_new_item' => 'Neues Produkt',
                'edit_item' => 'Produkt bearbeiten',
                'search_items' => 'Produkte suchen',
                'not_found' => 'Noch keine Produkte',
                'menu_name' => 'Raumplaner-Produkte',
            ],
            'public' => false,
            'show_ui' => true,
            'show_in_menu' => true,
            'menu_icon' => 'dashicons-cart',
            'supports' => ['title'],
        ]);
    }

    private static function categories(): array
    {
        $catalog = json_decode((string) file_get_contents(DM3D_DIR . 'data/catalog.json'), true);
        return $catalog['categories'] ?? [];
    }

    public static function meta_box(WP_Post $post): void
    {
        wp_nonce_field('dm3d_product', 'dm3d_product_nonce');
        $cats = self::categories();
        echo '<table class="form-table" role="presentation">';
        foreach (self::FIELDS as $key => [$label, $type]) {
            $value = (string) get_post_meta($post->ID, '_dm3d_' . $key, true);
            echo '<tr><th scope="row"><label for="dm3d_' . esc_attr($key) . '">' . esc_html($label) . '</label></th><td>';
            if ($type === 'category') {
                echo '<select name="dm3d_' . esc_attr($key) . '" id="dm3d_' . esc_attr($key) . '">';
                foreach ($cats as $k => $c) {
                    printf('<option value="%s"%s>%s%s</option>', esc_attr($k), selected($value, $k, false), esc_html($c['label']),
                        ($c['group'] ?? '') === 'deko' ? ' (Deko)' : '');
                }
                echo '</select><p class="description">Bestimmt die Form des 3D-Modells. Größe und Farbe kommen aus den Feldern unten.</p>';
            } elseif ($type === 'group') {
                echo '<select name="dm3d_group" id="dm3d_group">';
                foreach (['' => 'Automatisch (nach Art)', 'regale' => 'Regale', 'moebel' => 'Möbel', 'deko' => 'Deko', 'werkzeug' => 'Werkzeug (nicht im Raum, nur bei Werkzeugen)', 'verbindung' => 'Verbindungen (Werkbank)'] as $k => $l) {
                    printf('<option value="%s"%s>%s</option>', esc_attr($k), selected($value, $k, false), esc_html($l));
                }
                echo '</select>';
            } elseif ($type === 'variants') {
                $list = json_decode($value, true);
                $text = is_array($list) ? implode(', ', array_map(function ($v) { return $v['name'] . ' ' . $v['color']; }, $list)) : '';
                printf('<input type="text" name="dm3d_%s" id="dm3d_%s" value="%s" class="large-text">', esc_attr($key), esc_attr($key), esc_attr($text));
                echo '<p class="description">Mit Komma trennen, z. B. <code>weiß, Eiche, Salbei #a9b9a6</code>. Die erste Variante ist die Standardfarbe. Leer lassen = nur die Farbe oben.</p>';
            } else {
                $html_type = ['url' => 'url', 'number' => 'number', 'color' => 'color'][$type];
                $extra = $type === 'number' ? ' step="0.01" min="0"' : '';
                $class = $type === 'url' ? 'large-text' : 'small-text';
                printf('<input type="%s" name="dm3d_%s" id="dm3d_%s" value="%s" class="%s"%s>',
                    $html_type, esc_attr($key), esc_attr($key), esc_attr($value ?: ($type === 'color' ? '#c9b8a0' : '')), $class, $extra);
                if ($key === 'image') {
                    echo '<p class="description">Bei Amazon die Bildadresse aus dem SiteStripe bzw. Partnernet verwenden.</p>';
                }
            }
            echo '</td></tr>';
        }
        echo '</table>';
    }

    public static function save(int $post_id, WP_Post $post): void
    {
        if (!isset($_POST['dm3d_product_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['dm3d_product_nonce'])), 'dm3d_product')) {
            return;
        }
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE || !current_user_can('edit_post', $post_id)) {
            return;
        }
        foreach (self::FIELDS as $key => [, $type]) {
            $raw = isset($_POST['dm3d_' . $key]) ? wp_unslash($_POST['dm3d_' . $key]) : '';
            if ($type === 'url') $value = esc_url_raw(trim((string) $raw));
            elseif ($type === 'number') $value = $raw === '' ? '' : (string) max(0, (float) str_replace(',', '.', (string) $raw));
            elseif ($type === 'color') $value = sanitize_hex_color((string) $raw) ?: '';
            elseif ($type === 'group') $value = in_array($raw, ['regale', 'moebel', 'deko', 'werkzeug', 'verbindung'], true) ? $raw : '';
            elseif ($type === 'variants') {
                $raw = sanitize_text_field((string) $raw);
                $list = $raw === '' ? [] : DM3D_Import::parse_variants($raw, sanitize_hex_color((string) ($_POST['dm3d_color'] ?? '')) ?: '#c9b8a0');
                $value = $list ? wp_slash(wp_json_encode($list, JSON_UNESCAPED_UNICODE)) : '';
                // Erste Variante = Standardfarbe
                if ($list) update_post_meta($post_id, '_dm3d_color', $list[0]['color']);
            }
            else $value = sanitize_key((string) $raw);
            update_post_meta($post_id, '_dm3d_' . $key, $value);
        }
    }

    public static function source(string $url): string
    {
        $host = (string) wp_parse_url($url, PHP_URL_HOST);
        if (preg_match('/(^|\.)ikea\./', $host)) return 'ikea';
        if (preg_match('/(^|\.)(amazon\.|amzn\.)/', $host)) return 'amazon';
        return 'other';
    }

    /** Amazon-Link mit Partner-Tag versehen (sofern eingetragen). */
    public static function affiliate_url(string $url): string
    {
        $tag = trim((string) get_option(self::OPT_AMAZON_TAG, ''));
        if ($tag === '' || self::source($url) !== 'amazon') {
            return $url;
        }
        return add_query_arg('tag', rawurlencode($tag), remove_query_arg('tag', $url));
    }

    public static function product(int $id): array
    {
        $m = function ($k) use ($id) { return (string) get_post_meta($id, '_dm3d_' . $k, true); };
        $cats = self::categories();
        $cat = $m('category');
        if (!isset($cats[$cat])) $cat = 'box';
        $def = $cats[$cat]['size'] ?? [0.5, 0.5, 0.5];
        $size = [];
        foreach (['width', 'depth', 'height'] as $i => $k) {
            $v = (float) $m($k);
            $size[] = $v > 0 ? round($v / 100, 3) : $def[$i];
        }
        $url = $m('url');
        $color = $m('color') ?: ($cats[$cat]['color'] ?? '#c9b8a0');
        $variants = [];
        foreach ((array) json_decode($m('variants'), true) as $v) {
            if (is_array($v) && !empty($v['name']) && !empty($v['color'])) {
                $variants[] = ['name' => (string) $v['name'], 'color' => (string) $v['color']];
            }
        }
        return [
            'id' => (string) $id,
            'name' => html_entity_decode((string) get_post_field('post_title', $id, 'raw'), ENT_QUOTES | ENT_HTML5, 'UTF-8'),
            'url' => $url ? self::affiliate_url($url) : '',
            'source' => self::source($url),
            'image' => $m('image'),
            'price' => $m('price') !== '' ? (float) $m('price') : null,
            'category' => $cat,
            'size' => $size,
            'color' => $variants[0]['color'] ?? $color,
            'variants' => $variants ?: [['name' => 'Standard', 'color' => $color]],
            'group' => self::group($m('group'), $cat, $cats),
        ] + ($m('group') === 'verbindung' ? ['conn' => [
            'sub' => $m('sub'), 'kind' => $m('kind'), 'length' => $m('length'), 'diameter' => $m('diameter'),
            'material' => $m('material'), 'finish' => $m('finish'), 'pack' => $m('pack'),
        ]] : []);
    }

    /** Bereich im Möbel-Menü: gespeichert (aus der Tabelle) oder aus dem 3D-Modell abgeleitet. */
    public static function group(string $stored, string $cat, array $cats): string
    {
        if (in_array($stored, ['regale', 'moebel', 'deko', 'werkzeug', 'verbindung'], true)) return $stored;
        if (in_array($cat, ['shelf', 'wall_shelf'], true)) return 'regale';
        if (($cats[$cat]['group'] ?? '') === 'deko' || in_array($cat, ['rug', 'plant', 'lamp'], true)) return 'deko';
        return 'moebel';
    }

    /** Alle veröffentlichten Produkte für den Editor. */
    public static function all(): array
    {
        $ids = get_posts(['post_type' => self::TYPE, 'post_status' => 'publish', 'numberposts' => 500, 'fields' => 'ids', 'orderby' => 'title', 'order' => 'ASC']);
        return [
            'products' => array_map([self::class, 'product'], $ids),
            'amazon_tag' => trim((string) get_option(self::OPT_AMAZON_TAG, '')),
        ];
    }
}
