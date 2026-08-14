<?php
declare(strict_types=1);

// 极简同步接口：数据只保存为当前目录下的 shortcuts.json。
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');

$config = require __DIR__ . DIRECTORY_SEPARATOR . 'config.php';
$stateFile = __DIR__ . DIRECTORY_SEPARATOR . 'shortcuts.json';

function reply(array $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function base64Url(string $value): string {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function sessionCookie(array $config): string {
    $payload = base64Url(json_encode(['exp' => time() + ((int)$config['cookie_days'] * 86400)]));
    return $payload . '.' . hash_hmac('sha256', $payload, (string)$config['session_secret']);
}

function validSession(array $config): bool {
    $cookie = (string)($_COOKIE['shortcut_session'] ?? '');
    $parts = explode('.', $cookie, 2);
    if (count($parts) !== 2) return false;
    $expected = hash_hmac('sha256', $parts[0], (string)$config['session_secret']);
    if (!hash_equals($expected, $parts[1])) return false;
    $encoded = strtr($parts[0], '-_', '+/');
    $encoded .= str_repeat('=', (4 - strlen($encoded) % 4) % 4);
    $payload = json_decode((string)base64_decode($encoded), true);
    return is_array($payload) && (int)($payload['exp'] ?? 0) > time();
}

function readState(string $file): array {
    if (!is_file($file)) return ['revision' => 0, 'updatedAt' => '', 'items' => []];
    $data = json_decode((string)file_get_contents($file), true);
    if (!is_array($data)) return ['revision' => 0, 'updatedAt' => '', 'items' => []];
    return [
        'revision' => max(0, (int)($data['revision'] ?? 0)),
        'updatedAt' => (string)($data['updatedAt'] ?? ''),
        'items' => is_array($data['items'] ?? null) ? $data['items'] : [],
    ];
}

function cleanItems(array $items): array {
    $clean = [];
    foreach (array_slice($items, 0, 1000) as $item) {
        if (!is_array($item)) continue;
        $id = trim((string)($item['id'] ?? ''));
        $title = trim((string)($item['title'] ?? ''));
        $url = trim((string)($item['url'] ?? ''));
        if ($id === '' || $title === '' || !preg_match('#^https?://#i', $url)) continue;
        $clean[] = [
            'id' => substr($id, 0, 100),
            'title' => substr($title, 0, 240),
            'url' => substr($url, 0, 2000),
            'updatedAt' => substr((string)($item['updatedAt'] ?? gmdate('c')), 0, 40),
        ];
    }
    return $clean;
}

function iconDirectory(): string {
    return __DIR__ . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'icons';
}

function iconFile(string $directory, string $id): string {
    return $directory . DIRECTORY_SEPARATOR . hash('sha256', $id) . '.img';
}

function fetchRemote(string $url): array {
    $body = false;
    $contentType = '';
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_USERAGENT => 'PersonalShortcuts/1.0',
            CURLOPT_HTTPHEADER => ['Accept: image/avif,image/webp,image/png,image/*;q=0.8'],
        ]);
        $body = curl_exec($curl);
        $contentType = (string)curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
        curl_close($curl);
    } else {
        $context = stream_context_create([
            'http' => [
                'timeout' => 8,
                'ignore_errors' => true,
                'header' => "User-Agent: PersonalShortcuts/1.0\r\nAccept: image/png,image/*;q=0.8\r\n",
            ],
            'https' => [
                'timeout' => 8,
                'ignore_errors' => true,
                'header' => "User-Agent: PersonalShortcuts/1.0\r\nAccept: image/png,image/*;q=0.8\r\n",
            ],
        ]);
        $body = @file_get_contents($url, false, $context);
        foreach (($http_response_header ?? []) as $header) {
            if (stripos($header, 'Content-Type:') === 0) $contentType = trim(substr($header, 13));
        }
    }
    return [$body, strtolower(trim(explode(';', $contentType)[0]))];
}

function downloadIcon(string $pageUrl, string $path): bool {
    $host = (string)(parse_url($pageUrl, PHP_URL_HOST) ?? '');
    if ($host === '') return false;
    $sources = [
        'https://www.google.com/s2/favicons?domain=' . rawurlencode($host) . '&sz=64',
    ];
    $scheme = strtolower((string)(parse_url($pageUrl, PHP_URL_SCHEME) ?? 'https'));
    $port = parse_url($pageUrl, PHP_URL_PORT);
    $origin = $scheme . '://' . $host . ($port ? ':' . (int)$port : '');
    $sources[] = $origin . '/favicon.ico';
    $allowed = ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/gif', 'image/webp'];
    foreach ($sources as $source) {
        [$body, $contentType] = fetchRemote($source);
        if (!is_string($body) || $body === '' || strlen($body) > 1048576) continue;
        $imageInfo = @getimagesizefromstring($body);
        $mime = is_array($imageInfo) ? (string)($imageInfo['mime'] ?? '') : $contentType;
        if (!in_array($mime, $allowed, true)) continue;
        return file_put_contents($path, $body, LOCK_EX) !== false;
    }
    return false;
}

function iconMime(string $path): string {
    $info = @getimagesize($path);
    return is_array($info) && !empty($info['mime']) ? (string)$info['mime'] : 'application/octet-stream';
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

if ($action === 'login' && $method === 'POST') {
    $input = json_decode((string)file_get_contents('php://input'), true);
    $password = (string)($input['password'] ?? '');
    if ($password === '' || !hash_equals((string)$config['password'], $password)) {
        reply(['ok' => false, 'message' => '密码不正确。'], 401);
    }
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    setcookie('shortcut_session', sessionCookie($config), [
        'expires' => time() + ((int)$config['cookie_days'] * 86400),
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    reply(['ok' => true]);
}

if (!validSession($config)) reply(['ok' => false, 'message' => '需要登录。'], 401);

$state = readState($stateFile);
if ($action === 'icon' && $method === 'GET') {
    $id = trim((string)($_GET['id'] ?? ''));
    $item = null;
    foreach ($state['items'] as $candidate) {
        if (is_array($candidate) && (string)($candidate['id'] ?? '') === $id) {
            $item = $candidate;
            break;
        }
    }
    $directory = iconDirectory();
    $path = iconFile($directory, $id);
    if (!is_array($item)) { http_response_code(404); exit; }
    if (!is_file($path)) {
        if ((!is_dir($directory) && !@mkdir($directory, 0750, true)) || !downloadIcon((string)$item['url'], $path)) {
            http_response_code(404);
            exit;
        }
    }
    header('Content-Type: ' . iconMime($path));
    header('Cache-Control: public, max-age=31536000, immutable');
    header('Content-Length: ' . (string)filesize($path));
    readfile($path);
    exit;
}
if ($action === 'events' && $method === 'GET') {
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no');
    @set_time_limit(35);
    @ini_set('output_buffering', 'off');
    @ini_set('zlib.output_compression', '0');
    while (ob_get_level() > 0) @ob_end_flush();
    ob_implicit_flush(true);

    $since = (int)($_GET['revision'] ?? -1);
    $deadline = microtime(true) + 30;
    while (microtime(true) < $deadline) {
        clearstatcache(true, $stateFile);
        $current = readState($stateFile);
        if ((int)$current['revision'] !== $since) {
            echo "event: state\n";
            echo 'data: ' . json_encode(['ok' => true] + $current, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n";
            flush();
            exit;
        }
        echo ": keep-alive\n\n";
        flush();
        sleep(1);
    }
    echo "event: timeout\ndata: {}\n\n";
    flush();
    exit;
}
if ($method === 'GET') reply(['ok' => true] + $state);
if ($method !== 'PUT') reply(['ok' => false, 'message' => '只支持 GET 和 PUT。'], 405);

$input = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($input) || !is_array($input['items'] ?? null)) {
    reply(['ok' => false, 'message' => '请求格式不正确。'], 400);
}

$baseRevision = (int)($input['baseRevision'] ?? -1);
if ($baseRevision !== $state['revision']) {
    reply(['ok' => false, 'message' => '其他设备已有更新。', 'state' => $state], 409);
}

$newState = [
    'revision' => $state['revision'] + 1,
    'updatedAt' => gmdate('c'),
    'items' => cleanItems($input['items']),
];
$directory = iconDirectory();
if (!is_dir($directory)) @mkdir($directory, 0750, true);
$oldItems = [];
foreach ($state['items'] as $oldItem) {
    if (is_array($oldItem) && isset($oldItem['id'])) $oldItems[(string)$oldItem['id']] = $oldItem;
}
foreach ($newState['items'] as $newItem) {
    $oldItem = $oldItems[$newItem['id']] ?? null;
    $path = iconFile($directory, $newItem['id']);
    if (!is_array($oldItem) || (string)($oldItem['url'] ?? '') !== $newItem['url']) {
        @unlink($path);
        downloadIcon($newItem['url'], $path);
    }
}
$activeIconFiles = [];
foreach ($newState['items'] as $newItem) $activeIconFiles[basename(iconFile($directory, $newItem['id']))] = true;
foreach ((glob($directory . DIRECTORY_SEPARATOR . '*.img') ?: []) as $oldIcon) {
    if (!isset($activeIconFiles[basename($oldIcon)])) @unlink($oldIcon);
}
$json = json_encode($newState, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
if ($json === false || file_put_contents($stateFile, $json . PHP_EOL, LOCK_EX) === false) {
    reply(['ok' => false, 'message' => '无法写入 shortcuts.json，请检查目录权限。'], 500);
}

reply(['ok' => true] + $newState);
