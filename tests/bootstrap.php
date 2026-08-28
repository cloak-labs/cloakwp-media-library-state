<?php

declare(strict_types=1);

$autoload = dirname(__DIR__) . '/vendor/autoload.php';
if (!is_readable($autoload)) {
  spl_autoload_register(static function (string $class): void {
    $prefix = 'CloakWP\\MediaLibraryState\\';
    if (!str_starts_with($class, $prefix)) {
      return;
    }
    $relative = substr($class, strlen($prefix));
    $path = dirname(__DIR__) . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_readable($path)) {
      require_once $path;
    }
  });
} else {
  require $autoload;
}

if (!function_exists('sanitize_key')) {
  function sanitize_key($key): string
  {
    $key = strtolower((string) $key);

    return (string) preg_replace('/[^a-z0-9_\-]/', '', $key);
  }
}

if (!function_exists('add_action')) {
  function add_action($hook, $callback, $priority = 10, $accepted_args = 1): void
  {
  }
}

if (!function_exists('add_filter')) {
  function add_filter($hook, $callback, $priority = 10, $accepted_args = 1): void
  {
  }
}

if (!function_exists('apply_filters')) {
  function apply_filters($hook, $value, ...$args)
  {
    return $value;
  }
}

if (!function_exists('__')) {
  function __(string $text, string $domain = 'default'): string
  {
    return $text;
  }
}
