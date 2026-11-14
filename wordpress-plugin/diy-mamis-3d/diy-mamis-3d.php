<?php
/**
 * Plugin Name: DIY Mamis Raumplaner
 * Description: 3D-Raumplaner: Aus Video, Fotos oder Grundriss wird per KI ein editierbarer 3D-Raum. Einbinden per Shortcode [diy_mamis_raumplaner].
 * Version: 0.10.0
 * Requires at least: 6.5
 * Requires PHP: 7.4
 * Text Domain: diy-mamis-3d
 */

if (!defined('ABSPATH')) {
    exit;
}

const DM3D_VERSION = '0.10.0';
const DM3D_OPT_KEY = 'dm3d_api_key';
const DM3D_OPT_MODEL = 'dm3d_model';
const DM3D_OPT_LOGIN = 'dm3d_login_required';
define('DM3D_DIR', plugin_dir_path(__FILE__));

require_once DM3D_DIR . 'includes/store.php';
require_once DM3D_DIR . 'includes/claude.php';
require_once DM3D_DIR . 'includes/rest.php';
require_once DM3D_DIR . 'includes/products.php';
require_once DM3D_DIR . 'includes/import.php';

DM3D_Products::init();
DM3D_Import::init();

add_action('rest_api_init', [DM3D_Rest::class, 'register']);

// --------------------------------------------------------------------------- Einstellungen

add_action('admin_menu', function () {
    add_options_page('DIY Mamis Raumplaner', 'DIY Mamis Raumplaner', 'manage_options', 'dm3d', 'dm3d_settings_page');
});

add_action('admin_init', function () {
    register_setting('dm3d', DM3D_OPT_KEY, [
        'type' => 'string',
        'default' => '',
        // Leeres Feld = bisherigen Key behalten (er wird im Formular nicht angezeigt).
        'sanitize_callback' => function ($value) {
            $value = trim((string) $value);
            return $value === '' ? (string) get_option(DM3D_OPT_KEY, '') : $value;
        },
    ]);
    register_setting('dm3d', DM3D_OPT_MODEL, [
        'type' => 'string',
        'default' => 'claude-opus-5-5',
        'sanitize_callback' => function ($value) {
            return preg_replace('/[^a-z0-9.\-]/', '', strtolower((string) $value)) ?: 'claude-opus-5-5';
        },
    ]);
    register_setting('dm3d', DM3D_Products::OPT_AMAZON_TAG, [
        'type' => 'string',
        'default' => '',
        'sanitize_callback' => function ($value) {
            return preg_replace('/[^A-Za-z0-9_\-]/', '', (string) $value);
        },
    ]);
    register_setting('dm3d', DM3D_OPT_LOGIN, [
        'type' => 'string',
        'default' => '1',
        'sanitize_callback' => function ($value) {
            return $value ? '1' : '0';
        },
    ]);
});

// Der API-Key soll nicht bei jedem Seitenaufruf mitgeladen werden.
add_action('add_option_' . DM3D_OPT_KEY, function () {
    wp_set_option_autoload(DM3D_OPT_KEY, false);
});

function dm3d_settings_page()
{
    $from_constant = defined('DM3D_ANTHROPIC_API_KEY') && DM3D_ANTHROPIC_API_KEY;
    $has_key = DM3D_Claude::available();
    ?>
    <div class="wrap">
        <h1>DIY Mamis Raumplaner</h1>
        <form method="post" action="options.php">
            <?php settings_fields('dm3d'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="dm3d_api_key">Anthropic API-Key</label></th>
                    <td>
                        <?php if ($from_constant) : ?>
                            <p>Der Key ist in der <code>wp-config.php</code> hinterlegt (<code>DM3D_ANTHROPIC_API_KEY</code>).</p>
                        <?php else : ?>
                            <input name="<?php echo esc_attr(DM3D_OPT_KEY); ?>" id="dm3d_api_key" type="password" class="regular-text"
                                   autocomplete="off" value="" placeholder="<?php echo $has_key ? 'gespeichert, zum Ändern neu eingeben' : 'sk-ant-…'; ?>">
                            <p class="description">
                                <?php echo $has_key ? '✅ Ein Key ist gespeichert.' : '❌ Noch kein Key gespeichert.'; ?>
                                Alternativ in der <code>wp-config.php</code>: <code>define('DM3D_ANTHROPIC_API_KEY', '…');</code>
                            </p>
                        <?php endif; ?>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="dm3d_model">KI-Modell</label></th>
                    <td>
                        <input name="<?php echo esc_attr(DM3D_OPT_MODEL); ?>" id="dm3d_model" type="text" class="regular-text"
                               value="<?php echo esc_attr(DM3D_Claude::model()); ?>">
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="dm3d_amazon_tag">Amazon-Partner-Tag</label></th>
                    <td>
                        <input name="<?php echo esc_attr(DM3D_Products::OPT_AMAZON_TAG); ?>" id="dm3d_amazon_tag" type="text" class="regular-text"
                               placeholder="z. B. diymamis-21" value="<?php echo esc_attr(get_option(DM3D_Products::OPT_AMAZON_TAG, '')); ?>">
                        <p class="description">Wird an alle Amazon-Links im Raumplaner angehängt (Produktliste und von Nutzern eingefügte Links).
                            Produkte pflegst du unter <a href="<?php echo esc_url(admin_url('edit.php?post_type=' . DM3D_Products::TYPE)); ?>">Raumplaner-Produkte</a>.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row">Zugang</th>
                    <td>
                        <label>
                            <input name="<?php echo esc_attr(DM3D_OPT_LOGIN); ?>" type="checkbox" value="1" <?php checked(get_option(DM3D_OPT_LOGIN, '1'), '1'); ?>>
                            Neue Räume nur für angemeldete Nutzer (empfohlen, jede Analyse kostet KI-Guthaben)
                        </label>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
        <p>Einbinden: Shortcode <code>[diy_mamis_raumplaner]</code> auf einer Seite einfügen. Die Seite zeigt dann
            nur den Raumplaner, bildschirmfüllend und ohne Kopfzeile des Themes.</p>
        <p>Soll der Raumplaner stattdessen innerhalb der normalen Seite erscheinen:
            <code>[diy_mamis_raumplaner ansicht="seite"]</code>, optional mit <code>hoehe="800px"</code>
            und <code>breite="voll"</code>.</p>
    </div>
    <?php
}

// --------------------------------------------------------------------------- Vollbild
// Seiten mit dem Shortcode zeigen den Raumplaner bildschirmfüllend, ohne Kopfzeile, Menü und
// Hintergrund des Themes. Mit [diy_mamis_raumplaner ansicht="seite"] bleibt er in der Seite.

function dm3d_is_fullscreen_page(): bool
{
    static $result = null;
    if ($result !== null) {
        return $result;
    }
    $result = false;
    if (!is_singular()) {
        return $result;
    }
    $post = get_post();
    if (!$post || !has_shortcode($post->post_content, 'diy_mamis_raumplaner')) {
        return $result;
    }
    if (preg_match_all('/' . get_shortcode_regex(['diy_mamis_raumplaner']) . '/', $post->post_content, $m)) {
        foreach ($m[3] as $raw) {
            $atts = shortcode_parse_atts($raw);
            if (is_array($atts) && ($atts['ansicht'] ?? '') === 'seite') {
                return $result;
            }
        }
    }
    return $result = true;
}

add_filter('template_include', function ($template) {
    return dm3d_is_fullscreen_page() ? DM3D_DIR . 'templates/vollbild.php' : $template;
}, 99);

// Im Vollbild nur die eigenen Styles laden, damit das Theme nichts überschreibt.
add_action('wp_enqueue_scripts', function () {
    if (!dm3d_is_fullscreen_page()) {
        return;
    }
    dm3d_enqueue_assets(); // schon im <head>, damit die Seite nicht kurz ungestylt erscheint
    // Emoji-Skript von WordPress im Vollbild nicht laden (ersetzt Zeichen durch Bilder von s.w.org)
    remove_action('wp_head', 'print_emoji_detection_script', 7);
    remove_action('wp_print_styles', 'print_emoji_styles');
    global $wp_styles;
    foreach ((array) $wp_styles->queue as $handle) {
        if (!in_array($handle, ['dm3d-editor', 'admin-bar', 'dashicons'], true)) {
            wp_dequeue_style($handle);
        }
    }
}, 9999);

// --------------------------------------------------------------------------- Shortcode

function dm3d_enqueue_assets(): void
{
    if (wp_style_is('dm3d-editor', 'enqueued')) {
        return;
    }
    $base = plugin_dir_url(__FILE__) . 'assets/';
    wp_enqueue_style('dm3d-editor', $base . 'editor.css', [], DM3D_VERSION);
    if (function_exists('wp_enqueue_script_module')) {
        wp_enqueue_script_module('dm3d-editor', $base . 'editor.js', [], DM3D_VERSION);
    } else {
        wp_enqueue_script('dm3d-editor', $base . 'editor.js', [], DM3D_VERSION, true);
        add_filter('script_loader_tag', function ($tag, $handle) {
            return $handle === 'dm3d-editor' ? str_replace('<script ', '<script type="module" ', $tag) : $tag;
        }, 10, 2);
    }
}

add_shortcode('diy_mamis_raumplaner', function ($atts) {
    $atts = shortcode_atts(['hoehe' => '', 'breite' => 'spalte', 'ansicht' => ''], $atts, 'diy_mamis_raumplaner');
    $fullscreen = dm3d_is_fullscreen_page();
    dm3d_enqueue_assets();
    $style = $atts['hoehe'] && !$fullscreen ? sprintf(' style="height:%s"', esc_attr($atts['hoehe'])) : '';
    if ($fullscreen) {
        $class = ' class="dm-fullpage dm-vollbild"';
    } else {
        $class = $atts['breite'] === 'voll' ? ' class="alignfull dm-fullbleed"' : '';
    }
    return sprintf(
        '<div data-diy-mamis%s data-api="%s" data-nonce="%s" data-back-url="%s" data-back-label="%s"%s></div>',
        $class,
        esc_attr(untrailingslashit(rest_url(DM3D_Rest::NS))),
        esc_attr(wp_create_nonce('wp_rest')),
        $fullscreen ? esc_url(home_url('/')) : '',
        esc_attr(get_bloginfo('name')),
        $style
    );
});
