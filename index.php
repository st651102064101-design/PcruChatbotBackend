<?php
/**
 * PHP Reverse Proxy for Node.js Backend
 * Forwards all requests to Node.js server running on port 36145
 * Uses file_get_contents instead of cURL (cURL not available)
 */

error_reporting(0);

// Target Node.js server
$target = 'http://127.0.0.1:36145';

// Get the request path (remove the base path)
$requestUri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
$basePath = '/~s651102064101/backend';
$path = str_replace($basePath, '', $requestUri);

// Remove index.php from path
$path = str_replace('/index.php', '', $path);

// If path is empty, set to /
if (empty($path)) {
    $path = '/';
}

// Build the target URL
$targetUrl = $target . $path;

// Get request method
$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

// Build headers
$headers = [
    'X-Forwarded-For: ' . (isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : ''),
    'X-Forwarded-Proto: https',
    'X-Forwarded-Host: ict.pcru.ac.th',
    'Content-Type: ' . (isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : 'application/json'),
];

// Get request body for POST/PUT/PATCH
$postData = null;
if (in_array($method, ['POST', 'PUT', 'PATCH'])) {
    $postData = file_get_contents('php://input');
}

// Build stream context
$contextOptions = [
    'http' => [
        'method' => $method,
        'header' => implode("\r\n", $headers),
        'timeout' => 30,
        'ignore_errors' => true,
    ]
];

if ($postData) {
    $contextOptions['http']['content'] = $postData;
}

$context = stream_context_create($contextOptions);

// Make request
$response = @file_get_contents($targetUrl, false, $context);

// Get response headers
$responseHeaders = isset($http_response_header) ? $http_response_header : [];

// Parse HTTP status
$httpCode = 502;
if (!empty($responseHeaders)) {
    foreach ($responseHeaders as $header) {
        if (preg_match('/^HTTP\/\d\.\d\s+(\d+)/', $header, $matches)) {
            $httpCode = (int)$matches[1];
            break;
        }
    }
}

// Check for errors
if ($response === false && empty($responseHeaders)) {
    http_response_code(502);
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    echo json_encode([
        'error' => 'Backend connection failed',
        'message' => 'Cannot connect to Node.js server',
        'target' => $targetUrl
    ]);
    exit;
}

// Set response code
http_response_code($httpCode);

// Forward response headers (skip status line)
foreach ($responseHeaders as $header) {
    if (preg_match('/^HTTP\//', $header)) continue;
    if (stripos($header, 'Transfer-Encoding:') === 0) continue;
    if (stripos($header, 'Connection:') === 0) continue;
    header($header);
}

// Ensure CORS headers
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS, PATCH');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
header('Access-Control-Allow-Credentials: true');

// Handle OPTIONS preflight
if ($method === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Output body
echo $response;
