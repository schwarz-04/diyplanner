<?php
/**
 * Plugin Name: DIY Mamis Raumplaner
 * Description: Bindet den 3D-Raumplaner (Video/Fotos/Grundriss → editierbare 3D-Szene) per Shortcode [diy_mamis_raumplaner] ein.
 * Version: 0.1.0
 * Requires at least: 6.5
 * Requires PHP: 7.4
 * Text Domain: diy-mamis-3d
 */

if (!defined('ABSPATH')) {
    exit;
}

const DM3D_VERSION = '0.1.0';
const DM3D_OPTION = 'dm3d_api_base';

/** Einstellungen → DIY Mamis Raumplaner: Adresse des Backends */
add_action('admin_menu', function () {
    add_options_page('DIY Mamis Raumplaner', 'DIY Mamis Raumplaner', 'manage_options', 'dm3d', 'dm3d_settings_page');
});

add_action('admin_init', function () {
    register_setting('dm3d', DM3D_OPTION, [
        'type' => 'string',
        'sanitize_callback' => function ($value) {
            return untrailingslashit(esc_url_raw(trim((string) $value)));
        },
        'default' => '',
    ]);
});

function dm3d_settings_page()
{
    ?>
    <div class="wrap">
        <h1>DIY Mamis Raumplaner</h1>
        <form method="post" action="options.php">
            <?php settings_fields('dm3d'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="dm3d_api_base">Backend-Adresse</label></th>
                    <td>
                        <input name="<?php echo esc_attr(DM3D_OPTION); ?>" id="dm3d_api_base" type="url" class="regular-text"
                               value="<?php echo esc_attr(get_option(DM3D_OPTION, '')); ?>" placeholder="https://app.example.de">
                        <p class="description">Die Subdomain, auf der das Backend (VPS) läuft.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
        <p>Einbinden: Shortcode <code>[diy_mamis_raumplaner]</code> auf einer Seite einfügen. Optional mit Höhe:
            <code>[diy_mamis_raumplaner hoehe="800px"]</code></p>
    </div>
    <?php
}

add_shortcode('diy_mamis_raumplaner', function ($atts) {
    $atts = shortcode_atts(['hoehe' => ''], $atts, 'diy_mamis_raumplaner');
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
    $style = $atts['hoehe'] ? sprintf(' style="height:%s"', esc_attr($atts['hoehe'])) : '';
    return sprintf(
        '<div data-diy-mamis data-api="%s"%s></div>',
        esc_attr(get_option(DM3D_OPTION, '')),
        $style
    );
});
