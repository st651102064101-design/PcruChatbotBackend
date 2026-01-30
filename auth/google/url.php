<?php
// Forward to Node.js backend
$nodeUrl = 'http://127.0.0.1:36145/auth/google/url' . ($_SERVER['QUERY_STRING'] ? '?' . $_SERVER['QUERY_STRING'] : '');
$response = @file_get_contents($nodeUrl);
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
echo $response ?: '{"error":"Backend unavailable"}';
