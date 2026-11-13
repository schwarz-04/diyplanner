<?php
/**
 * Leere Seite nur mit dem Raumplaner (ohne Kopfzeile, Menü und Fußzeile des Themes).
 */
if (!defined('ABSPATH')) {
    exit;
}
?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo('charset'); ?>">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <?php wp_head(); ?>
</head>
<body <?php body_class('dm3d-vollbild'); ?>>
<?php
wp_body_open();
while (have_posts()) {
    the_post();
    // Nur den Raumplaner ausgeben, sonstiger Seiteninhalt wird im Vollbild nicht gezeigt.
    echo do_shortcode('[diy_mamis_raumplaner]');
}
wp_footer();
?>
</body>
</html>
