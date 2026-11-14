<?php
/**
 * REST-Schnittstelle für den Editor: /wp-json/dm3d/v1/api/...
 *
 *   GET  api/health                   Ist die KI eingerichtet, darf der Nutzer Räume anlegen?
 *   GET  api/catalog                  Möbelkategorien, Paneele, Bodenarten
 *   GET  api/products                 Produktliste (IKEA, Amazon …) und Amazon-Partner-Tag
 *   GET  api/demo-scene               Beispielraum (Hintergrund der Startseite)
 *   POST api/projects                 Neues Projekt (Bilder aus dem Browser oder Demo-Raum)
 *   POST api/projects/<id>/analyze    KI-Analyse ausführen (dauert etwa eine Minute)
 *   GET  api/projects/<id>            Stand und Szene
 *   PUT  api/projects/<id>/scene      Szene speichern (ein Raum oder Wohnung mit rooms[])
 *   POST api/projects/<id>/meta       Name und Vorschaubild speichern („Speichern“)
 *   POST api/projects/<id>/copy       Kopie anlegen
 *   DELETE api/projects/<id>          Projekt löschen
 *   GET  api/my-projects?ids=…        Projektliste: eigene (angemeldet) und die im Browser gemerkten
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
        register_rest_route(self::NS, '/api/products', ['methods' => 'GET', 'callback' => [DM3D_Products::class, 'all'], 'permission_callback' => $public]);
        register_rest_route(self::NS, '/api/demo-scene', ['methods' => 'GET', 'callback' => [self::class, 'demo_scene'], 'permission_callback' => $public]);
        register_rest_route(self::NS, '/api/projects', ['methods' => 'POST', 'callback' => [self::class, 'create'], 'permission_callback' => $creator]);
        register_rest_route(self::NS, "/api/projects/$id", [
            ['methods' => 'GET', 'callback' => [self::class, 'get'], 'permission_callback' => $public],
            ['methods' => 'DELETE', 'callback' => [self::class, 'delete'], 'permission_callback' => $public],
        ]);
        register_rest_route(self::NS, "/api/projects/$id/meta", ['methods' => 'POST', 'callback' => [self::class, 'meta'], 'permission_callback' => $public]);
        register_rest_route(self::NS, "/api/projects/$id/copy", ['methods' => 'POST', 'callback' => [self::class, 'copy'], 'permission_callback' => $creator]);
        register_rest_route(self::NS, '/api/my-projects', ['methods' => 'GET', 'callback' => [self::class, 'my_projects'], 'permission_callback' => $public]);
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
            'version' => DM3D_VERSION,
            'analysis_available' => DM3D_Claude::available(),
            'can_create' => self::can_create(),
            'login_url' => wp_login_url(wp_get_referer() ?: home_url()),
        ];
    }

    public static function catalog()
    {
        return json_decode((string) file_get_contents(DM3D_DIR . 'data/catalog.json'), true);
    }

    public static function demo_scene()
    {
        return json_decode((string) file_get_contents(DM3D_DIR . 'data/demo-scene.json'), true);
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
            DM3D_Store::status($dir, ['kind' => 'demo', 'state' => 'ready', 'version' => 1, 'created' => time(), 'user' => get_current_user_id()]);
            self::remember($id);
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
        self::remember($id);
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

    // ------------------------------------------------------------------ Meine Projekte

    const USER_META = 'dm3d_projects';

    /** Projekt in die Liste des angemeldeten Nutzers aufnehmen (neueste zuerst, max. 200). */
    private static function remember(string $id): void
    {
        $user = get_current_user_id();
        if (!$user) return;
        $ids = (array) get_user_meta($user, self::USER_META, true);
        $ids = array_values(array_filter($ids, function ($x) use ($id) { return is_string($x) && $x !== $id; }));
        array_unshift($ids, $id);
        update_user_meta($user, self::USER_META, array_slice($ids, 0, 200));
    }

    private static function forget(string $id): void
    {
        $user = get_current_user_id();
        if (!$user) return;
        $ids = (array) get_user_meta($user, self::USER_META, true);
        update_user_meta($user, self::USER_META, array_values(array_filter($ids, function ($x) use ($id) { return $x !== $id; })));
    }

    /** Darf der aktuelle Nutzer das Projekt verwalten? Projekte angemeldeter Nutzer nur der Besitzer, sonst wer den Link hat. */
    private static function may_manage(array $status): bool
    {
        $owner = (int) ($status['user'] ?? 0);
        return $owner === 0 || $owner === get_current_user_id() || current_user_can('manage_options');
    }

    public static function meta(WP_REST_Request $req)
    {
        $id = $req['id'];
        $dir = DM3D_Store::dir($id);
        if (!$dir) return self::error('Projekt nicht gefunden.', 404);
        $status = DM3D_Store::status($dir);
        if (!self::may_manage($status)) return self::error('Keine Berechtigung.', 403);
        $changes = [];
        $name = $req->get_param('name');
        if (is_string($name)) $changes['name'] = mb_substr(sanitize_text_field($name), 0, 80);
        $thumb = $req->get_param('thumb');
        if (is_string($thumb) && strlen($thumb) < 300000 && preg_match('#^data:image/jpeg;base64,[A-Za-z0-9+/=]+$#', $thumb)) {
            file_put_contents($dir . '/thumb.txt', $thumb);
            $changes['thumb'] = true;
        }
        $changes['saved'] = time();
        DM3D_Store::status($dir, $changes);
        self::remember($id);
        return DM3D_Store::payload($id);
    }

    public static function copy(WP_REST_Request $req)
    {
        $src = DM3D_Store::dir($req['id']);
        if (!$src) return self::error('Projekt nicht gefunden.', 404);
        $scene = DM3D_Store::read($src, 'scene.json');
        if (!$scene) return self::error('Das Projekt hat noch keinen Raum.', 400);
        $old = DM3D_Store::status($src);
        [$id, $dir] = DM3D_Store::create();
        DM3D_Store::write($dir, 'scene.json', $scene);
        if (file_exists($src . '/thumb.txt')) copy($src . '/thumb.txt', $dir . '/thumb.txt');
        $name = is_string($req->get_param('name')) ? sanitize_text_field($req->get_param('name')) : '';
        DM3D_Store::status($dir, [
            'kind' => $old['kind'] ?? 'demo', 'state' => 'ready', 'version' => 1, 'created' => time(), 'saved' => time(),
            'user' => get_current_user_id(), 'thumb' => file_exists($dir . '/thumb.txt'),
            'name' => mb_substr($name ?: trim(($old['name'] ?? 'Projekt') . ' (Kopie)'), 0, 80),
        ]);
        self::remember($id);
        return ['id' => $id];
    }

    public static function delete(WP_REST_Request $req)
    {
        $id = $req['id'];
        $dir = DM3D_Store::dir($id);
        if (!$dir) {
            self::forget($id);
            return ['deleted' => true];
        }
        if (!self::may_manage(DM3D_Store::status($dir))) return self::error('Keine Berechtigung.', 403);
        foreach (glob($dir . '/*') ?: [] as $f) @unlink($f);
        @rmdir($dir);
        self::forget($id);
        return ['deleted' => true];
    }

    public static function my_projects(WP_REST_Request $req)
    {
        $ids = array_filter(explode(',', (string) $req->get_param('ids')), [DM3D_Store::class, 'valid_id']);
        $user = get_current_user_id();
        if ($user) $ids = array_merge((array) get_user_meta($user, self::USER_META, true), $ids);
        $out = [];
        foreach (array_slice(array_unique($ids), 0, 100) as $id) {
            $dir = DM3D_Store::dir((string) $id);
            if (!$dir) continue;
            $status = DM3D_Store::status($dir);
            // Fremde Projekte angemeldeter Nutzer nicht auflisten, auch wenn die ID im Browser steht
            $owner = (int) ($status['user'] ?? 0);
            if ($owner && $owner !== $user) continue;
            $scene = DM3D_Store::read($dir, 'scene.json');
            if (!$scene) continue;
            $rooms = isset($scene['rooms']) && is_array($scene['rooms']) ? array_map(function ($r) { return $r['scene'] ?? []; }, $scene['rooms']) : [$scene];
            $names = array_values(array_filter(array_map(function ($r) { return (string) ($r['room']['name'] ?? ''); }, $rooms)));
            $out[] = [
                'id' => $id,
                'name' => (string) ($status['name'] ?? '') ?: ($names[0] ?? 'Projekt'),
                'rooms' => count($rooms),
                'room_names' => $names,
                'updated' => (int) ($status['updated'] ?? $status['created'] ?? 0),
                'thumb' => file_exists($dir . '/thumb.txt') ? (string) file_get_contents($dir . '/thumb.txt') : '',
            ];
        }
        usort($out, function ($a, $b) { return $b['updated'] - $a['updated']; });
        return ['projects' => $out];
    }

    private static function valid_room($s): bool
    {
        return is_array($s) && isset($s['room']['polygon']) && is_array($s['room']['polygon'])
            && count($s['room']['polygon']) >= 3 && isset($s['walls'], $s['objects']);
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
        // Version 1: ein Raum; Version 2: Wohnung mit mehreren Räumen (rooms[].scene)
        $rooms = is_array($scene) && isset($scene['rooms']) && is_array($scene['rooms'])
            ? array_map(function ($r) { return is_array($r) ? ($r['scene'] ?? null) : null; }, $scene['rooms'])
            : [$scene];
        if (!$rooms || count($rooms) > 30) {
            return self::error('Ungültige Szene.', 400);
        }
        foreach ($rooms as $room) {
            if (!self::valid_room($room)) {
                return self::error('Ungültige Szene.', 400);
            }
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
