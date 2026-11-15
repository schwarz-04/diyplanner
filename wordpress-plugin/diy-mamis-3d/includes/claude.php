<?php
/**
 * KI-Analyse über die Claude-API (Messages API).
 *
 * Der Browser schickt fertige Einzelbilder (aus dem Video geschnitten) bzw. ein Grundriss-PDF.
 * Claude liefert eine strukturierte Raumbeschreibung (Structured Outputs, Schema in
 * data/room-analysis.schema.json). Der Editor wandelt sie in eine Szene um.
 *
 * Die Anfrage läuft direkt über die WordPress-HTTP-API statt über das PHP-SDK von Anthropic,
 * damit das Plugin ohne Composer-Abhängigkeiten auskommt und nicht mit anderen Plugins
 * kollidiert, die eigene Versionen derselben Bibliotheken mitbringen.
 */

if (!defined('ABSPATH')) {
    exit;
}

class DM3D_Claude
{
    const ENDPOINT = 'https://api.anthropic.com/v1/messages';
    const API_VERSION = '2026-10-21';

    public static function api_key(): string
    {
        if (defined('DM3D_ANTHROPIC_API_KEY') && DM3D_ANTHROPIC_API_KEY) {
            return (string) DM3D_ANTHROPIC_API_KEY;
        }
        return (string) get_option(DM3D_OPT_KEY, '');
    }

    public static function available(): bool
    {
        return self::api_key() !== '';
    }

    public static function model(): string
    {
        return (string) get_option(DM3D_OPT_MODEL, '') ?: 'claude-opus-5-5';
    }

    /**
     * @param array  $input ['images' => [['media_type' => ..., 'data' => base64]], 'pdf' => base64|null]
     * @return array Raumbeschreibung gemäß Schema
     * @throws RuntimeException mit einer Meldung für den Nutzer
     */
    public static function analyze(array $input, string $kind, string $hint): array
    {
        $data_dir = DM3D_DIR . 'data/';
        $apartment = $kind === 'apartment';
        $system = (string) file_get_contents($data_dir . ($apartment ? 'apartment-prompt.txt' : 'analysis-prompt.txt'));
        $schema = json_decode((string) file_get_contents($data_dir . ($apartment ? 'apartment-analysis.schema.json' : 'room-analysis.schema.json')), true);

        $content = [];
        foreach ($input['images'] ?? [] as $img) {
            $content[] = [
                'type' => 'image',
                'source' => ['type' => 'base64', 'media_type' => 'image/jpeg', 'data' => $img['data']],
            ];
        }
        if (!empty($input['pdf'])) {
            $content[] = [
                'type' => 'document',
                'source' => ['type' => 'base64', 'media_type' => 'application/pdf', 'data' => $input['pdf']],
            ];
        }
        $n = count($input['images'] ?? []);
        // Wohnung: die ersten plan_images Bilder (oder das PDF) sind der Grundriss, der Rest ergänzende Fotos/Videobilder
        $plan = (int) ($input['plan_images'] ?? 0);
        $extra = max(0, $n - $plan);
        $apartment_intro = ($input['pdf'] ?? null)
            ? 'Das PDF ist der Grundriss der Wohnung.' . ($n ? " Die $n Bilder sind ergänzende Fotos oder Videobilder der Räume." : '')
            : ($plan > 1 ? "Die ersten $plan Bilder sind der Grundriss der Wohnung (mehrere Seiten oder Ausschnitte)." : 'Das erste Bild ist der Grundriss der Wohnung.')
              . ($extra ? " Die folgenden $extra Bilder sind ergänzende Fotos oder Videobilder der Räume: nur für Möbel, Farben und Böden, nicht für Maße." : '');
        $intro = [
            'apartment' => $apartment_intro . ' Rekonstruiere alle Räume der Wohnung.',
            'video' => "Die $n Bilder sind Einzelbilder aus einem Rundum-Video eines Raums, in zeitlicher Reihenfolge.",
            'photos' => "Die $n Bilder sind Fotos desselben Raums aus verschiedenen Blickwinkeln.",
            'floorplan' => 'Das ist ein Grundriss. Rekonstruiere den Raum daraus.',
        ][$kind] ?? 'Rekonstruiere den Raum aus diesen Bildern.';
        $text = $intro . ($apartment ? ' Erstelle die Beschreibung der ganzen Wohnung.' : ' Erstelle die Raumbeschreibung.');
        if ($hint !== '') {
            $text .= "\n\nHinweis des Nutzers: " . $hint;
        }
        $content[] = ['type' => 'text', 'text' => $text];

        $body = [
            'model' => self::model(),
            'max_tokens' => $apartment ? 32000 : 16000,
            'system' => $system,
            'thinking' => ['type' => 'adaptive'],
            'output_config' => [
                'effort' => 'high',
                'format' => ['type' => 'json_schema', 'schema' => $schema],
            ],
            // Falls ein Sicherheitsfilter ablehnt, versucht die API automatisch ein Ersatzmodell.
            'fallbacks' => 'default',
            'messages' => [['role' => 'user', 'content' => $content]],
        ];

        $response = wp_remote_post(self::ENDPOINT, [
            'timeout' => $apartment ? 540 : 300,
            'headers' => [
                'content-type' => 'application/json',
                'x-api-key' => self::api_key(),
                'anthropic-version' => self::API_VERSION,
                'anthropic-beta' => 'server-side-fallback-2026-07-01',
            ],
            'body' => wp_json_encode($body),
        ]);
        if (is_wp_error($response)) {
            throw new RuntimeException('Die KI ist gerade nicht erreichbar: ' . $response->get_error_message());
        }
        $status = wp_remote_retrieve_response_code($response);
        $result = json_decode(wp_remote_retrieve_body($response), true);
        if ($status !== 200) {
            $msg = $result['error']['message'] ?? ('HTTP ' . $status);
            if ($status === 401) {
                $msg = 'Der API-Key wurde abgelehnt. Bitte in den Plugin-Einstellungen prüfen.';
            } elseif ($status === 429 || $status === 529) {
                $msg = 'Die KI ist gerade ausgelastet. Bitte in ein paar Minuten erneut versuchen.';
            }
            throw new RuntimeException('KI-Analyse fehlgeschlagen: ' . $msg);
        }
        $stop = $result['stop_reason'] ?? '';
        if ($stop === 'refusal') {
            throw new RuntimeException('Die KI hat die Analyse abgelehnt. Bitte andere Bilder versuchen.');
        }
        if ($stop === 'max_tokens') {
            throw new RuntimeException('Die KI-Antwort war unvollständig. Bitte erneut versuchen.');
        }
        foreach ($result['content'] ?? [] as $block) {
            if (($block['type'] ?? '') === 'text') {
                $analysis = json_decode($block['text'], true);
                if (is_array($analysis) && (isset($analysis['corners']) || ($apartment && !empty($analysis['rooms'])))) {
                    return $analysis;
                }
            }
        }
        throw new RuntimeException('Die KI-Antwort konnte nicht gelesen werden. Bitte erneut versuchen.');
    }
}
