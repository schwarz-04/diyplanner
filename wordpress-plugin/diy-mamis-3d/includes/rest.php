<?php
/**
 * REST-Schnittstelle für den Editor: /wp-json/dm3d/v1/api/...
 *
 *   GET  api/health                   Ist die KI eingerichtet, darf der Nutzer Räume anlegen?
 *   GET  api/catalog                  Möbelkategorien, Paneele, Bodenarten
 *   POST api/projects                 Neues Projekt (Bilder aus dem Browser oder Demo-Raum)
 *   POST api/projects/<id>/analyze    KI-Analyse ausführen (dauert etwa eine Minute)
 *   GET  api/projects/<id>            Stand und Szene
 *   PUT  api/projects/<id>/scene      Szene speichern
 */

if (!defined('ABSPATH')) {
    exit;
}

class DM3D_Rest
{
    const NS = 'dm3d/v1';
    const MAX_IMAGES = 16;
    const MAX_SCENE_BYTES = 2 * 1024 * 1024;

    public static function register(): void
    {
        $public = '__return_true';
        $creator = [self::class, 'can_create'];
        $id = '(?P<id>[a-f0-9]{32})';

        register_rest_route(self::NS, '/api/health', ['methods' => 'GET', 'callback' => [self::class, 'health'], 'permission_callback' => $public]);
        register_rest_route(self::NS, '/api/catalog', ['methods' => 'GET', 'callback' => [self::class, 'catalog'], 'permission_callback' => $public]);
        register_rest_route(self::NS, '/api/projects', ['methods' => 'POST', 'callback' => [self::class, 'create'], 'permission_callback' => $creator]);
        register_rest_route(self::NS, "/api/projects/$id", ['methods' => 'GET', 'callback' => [self::class, 'get'], 'permission_callback' => $public]);
        register_rest_route(self::NS, "/api/projects/$id/analyze", ['methods' => 'POST', 'callback' => [self::class, 'analyze'], 'permission_callback' => $creator]);
        register_rest_route(self::NS, "/api/projects/$id/scene", ['methods' => 'PUT', 'callback' => [self::class, 'save_scene'], 'permission_callback' => $public]);
    }

    /** Räume anlegen kostet KI-Guthaben, deshalb standardmäßig nur für angemeldete Nutzer. */
    public static function can_create(): bool
    {
        return !get_option(DM3D_OPT_LOGIN, '1') || is_user_logged_in();
    }

    private static function error(string $message, int $status)
    {
        return new WP_Error('dm3d_error', $message, ['status' => $status]);
    }

    public static function health(): array
    {
        return [
            'ok' => true,
            'analysis_available' => DM3D_Claude::available(),
            'can_create' => self::can_create(),
            'login_url' => wp_login_url(wp_get_referer() ?: home_url()),
        ];
    }

    public static function catalog()
    {
        return json_decode((string) file_get_contents(DM3D_DIR . 'data/catalog.json'), true);
    }

    public static function create(WP_REST_Request $req)
    {
        $kind = (string) $req->get_param('kind');
        if (!in_array($kind, ['video', 'photos', 'floorplan', 'demo'], true)) {
            return self::error('Unbekannte Eingabeart.', 400);
        }
        if ($kind === 'demo') {
            [$id, $dir] = DM3D_Store::create();
            $scene = json_decode((string) file_get_contents(DM3D_DIR . 'data/demo-scene.json'), true);
            DM3D_Store::write($dir, 'scene.json', $scene);
            DM3D_Store::status($dir, ['kind' => 'demo', 'state' => 'ready', 'version' => 1, 'created' => time()]);
            return ['id' => $id];
        }
        if (!DM3D_Claude::available()) {
            return self::error('Die KI-Analyse ist noch nicht eingerichtet (API-Key fehlt).', 503);
        }
        $images = [];
        foreach (array_slice((array) $req->get_param('images'), 0, self::MAX_IMAGES) as $img) {
            $data = is_array($img) ? (string) ($img['data'] ?? '') : '';
            $raw = base64_decode($data, true);
            if ($raw === false || substr($raw, 0, 3) !== "\xFF\xD8\xFF") {
                return self::error('Ein Bild ist beschädigt. Bitte erneut versuchen.', 400);
            }
            $images[] = ['media_type' => 'image/jpeg', 'data' => $data];
        }
        $pdf = (string) $req->get_param('pdf');
        if ($pdf !== '') {
            $raw = base64_decode($pdf, true);
            if ($raw === false || substr($raw, 0, 4) !== '%PDF') {
                return self::error('Das PDF ist beschädigt.', 400);
            }
        }
        if (!$images && $pdf === '') {
            return self::error('Bitte mindestens eine Datei hochladen.', 400);
        }
        $hint = mb_substr(sanitize_textarea_field((string) $req->get_param('hint')), 0, 500);
        [$id, $dir] = DM3D_Store::create();
        DM3D_Store::write($dir, 'input.json', ['images' => $images, 'pdf' => $pdf ?: null, 'hint' => $hint]);
        DM3D_Store::status($dir, [
            'kind' => $kind, 'state' => 'queued', 'step' => 'Wartet auf die KI', 'created' => time(),
            'user' => get_current_user_id(),
        ]);
        return ['id' => $id];
    }

    public static function get(WP_REST_Request $req)
    {
        $payload = DM3D_Store::payload($req['id']);
        return $payload ?: self::error('Projekt nicht gefunden.', 404);
    }

    public static function analyze(WP_REST_Request $req)
    {
        $id = $req['id'];
        $dir = DM3D_Store::dir($id);
        if (!$dir) {
            return self::error('Projekt nicht gefunden.', 404);
        }
        $status = DM3D_Store::status($dir);
        if (($status['state'] ?? '') !== 'queued') {
            return DM3D_Store::payload($id);
        }
        // Weiterlaufen, auch wenn der Browser oder ein Proxy die Verbindung vorher trennt.
        ignore_user_abort(true);
        if (function_exists('set_time_limit')) {
            @set_time_limit(360);
        }
        DM3D_Store::status($dir, ['state' => 'analyzing', 'step' => 'KI analysiert den Raum']);
        try {
            $input = DM3D_Store::read($dir, 'input.json') ?: [];
            $analysis = DM3D_Claude::analyze($input, (string) ($status['kind'] ?? 'video'), (string) ($input['hint'] ?? ''));
            DM3D_Store::write($dir, 'analysis.json', $analysis);
            DM3D_Store::status($dir, ['state' => 'ready', 'step' => '', 'error' => null]);
            @unlink($dir . '/input.json');
        } catch (Throwable $e) {
            DM3D_Store::status($dir, ['state' => 'error', 'error' => $e->getMessage()]);
        }
        return DM3D_Store::payload($id);
    }

    public static function save_scene(WP_REST_Request $req)
    {
        $id = $req['id'];
        $dir = DM3D_Store::dir($id);
        if (!$dir) {
            return self::error('Projekt nicht gefunden.', 404);
        }
        if (strlen($req->get_body()) > self::MAX_SCENE_BYTES) {
            return self::error('Die Szene ist zu groß.', 413);
        }
        $scene = $req->get_json_params();
        if (!is_array($scene) || !isset($scene['room']['polygon']) || !is_array($scene['room']['polygon'])
            || count($scene['room']['polygon']) < 3 || !isset($scene['walls'], $scene['objects'])) {
            return self::error('Ungültige Szene.', 400);
        }
        DM3D_Store::write($dir, 'scene.json', $scene);
        $status = DM3D_Store::status($dir);
        DM3D_Store::status($dir, ['version' => ($status['version'] ?? 0) + 1]);
        if (file_exists($dir . '/analysis.json')) {
            @unlink($dir . '/analysis.json');
        }
        return DM3D_Store::payload($id);
    }
}
