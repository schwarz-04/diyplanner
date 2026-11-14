<?php
/**
 * Projekt-Ablage im Upload-Ordner: wp-content/uploads/dm3d-projekte/<id>/
 *   input.json     Bilder (base64) und Hinweis für die KI-Analyse, wird danach gelöscht
 *   status.json    Stand der Verarbeitung
 *   analysis.json  Rohantwort der KI (bis der Editor daraus eine Szene gebaut hat)
 *   scene.json     aktuelle Szene (Quelle der Wahrheit)
 *
 * Die Projekt-ID ist lang und zufällig und dient vorerst als Zugangsschlüssel (Teilen-Link).
 * Der Ordner ist per .htaccess gegen direkten Abruf gesperrt.
 */

if (!defined('ABSPATH')) {
    exit;
}

class DM3D_Store
{
    public static function root(): string
    {
        $dir = trailingslashit(wp_upload_dir()['basedir']) . 'dm3d-projekte';
        if (!is_dir($dir)) {
            wp_mkdir_p($dir);
            file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
            file_put_contents($dir . '/index.php', "<?php // Kein Zugriff.\n");
        }
        return $dir;
    }

    public static function valid_id(string $id): bool
    {
        return (bool) preg_match('/^[a-f0-9]{32}$/', $id);
    }

    public static function dir(string $id): ?string
    {
        if (!self::valid_id($id)) {
            return null;
        }
        $dir = self::root() . '/' . $id;
        return is_dir($dir) ? $dir : null;
    }

    public static function create(): array
    {
        $id = bin2hex(random_bytes(16));
        $dir = self::root() . '/' . $id;
        wp_mkdir_p($dir);
        return [$id, $dir];
    }

    public static function read(string $dir, string $name)
    {
        $file = $dir . '/' . $name;
        if (!file_exists($file)) {
            return null;
        }
        return json_decode((string) file_get_contents($file), true);
    }

    public static function write(string $dir, string $name, $data): void
    {
        $tmp = $dir . '/' . $name . '.tmp';
        file_put_contents($tmp, wp_json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        rename($tmp, $dir . '/' . $name);
    }

    public static function status(string $dir, array $changes = []): array
    {
        $status = self::read($dir, 'status.json') ?: [];
        if ($changes) {
            $status = array_merge($status, $changes, ['updated' => time()]);
            self::write($dir, 'status.json', $status);
        }
        return $status;
    }

    public static function payload(string $id): ?array
    {
        $dir = self::dir($id);
        if (!$dir) {
            return null;
        }
        $status = self::status($dir);
        $scene = self::read($dir, 'scene.json');
        return [
            'id' => $id,
            'kind' => $status['kind'] ?? 'video',
            'state' => $status['state'] ?? 'unknown',
            'step' => $status['step'] ?? '',
            'error' => $status['error'] ?? null,
            'version' => $status['version'] ?? 0,
            'name' => $status['name'] ?? '',
            'scene' => $scene,
            'analysis' => $scene ? null : self::read($dir, 'analysis.json'),
        ];
    }
}
