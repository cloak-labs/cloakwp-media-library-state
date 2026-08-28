<?php

/**
 * Plugin Name:       Media Library State
 * Plugin URI:        https://github.com/cloak-labs/cloakwp-media-library-state
 * Description:       Remember where you are in the Media Library — Load more depth survives reloads and media modal reopenings.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      8.2
 * Author:            Cloak Labs
 * Author URI:        https://github.com/cloak-labs
 * License:           LGPL-3.0-or-later
 * License URI:       https://www.gnu.org/licenses/lgpl-3.0.html
 * Text Domain:       media-library-state
 * Domain Path:       /languages
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
  exit;
}

/*
 * Composer path repos symlink this package outside wp-content. PHP resolves
 * __FILE__/__DIR__ to the real path, which breaks plugins_url()/plugin_basename().
 * Prefer the public mu-plugins path WordPress (and the web server) actually serve.
 */
$cloakwpMediaLibraryStateFile = __FILE__;
$cloakwpMediaLibraryStateDir = __DIR__;
if (defined('WPMU_PLUGIN_DIR')) {
  $cloakwpMuPluginFile = WPMU_PLUGIN_DIR . '/media-library-state/media-library-state.php';
  if (is_readable($cloakwpMuPluginFile)) {
    $cloakwpMediaLibraryStateFile = $cloakwpMuPluginFile;
    $cloakwpMediaLibraryStateDir = dirname($cloakwpMuPluginFile);
  }
}

define('CLOAKWP_MEDIA_LIBRARY_STATE_FILE', $cloakwpMediaLibraryStateFile);
define('CLOAKWP_MEDIA_LIBRARY_STATE_DIR', $cloakwpMediaLibraryStateDir);
define('CLOAKWP_MEDIA_LIBRARY_STATE_VERSION', '0.1.0');

if (function_exists('wp_register_plugin_realpath')) {
  wp_register_plugin_realpath(CLOAKWP_MEDIA_LIBRARY_STATE_FILE);
}

if (is_readable(__DIR__ . '/vendor/autoload.php')) {
  require_once __DIR__ . '/vendor/autoload.php';
} elseif (!class_exists(\CloakWP\MediaLibraryState\MediaLibraryState::class, false)) {
  spl_autoload_register(static function (string $class): void {
    $prefix = 'CloakWP\\MediaLibraryState\\';
    if (!str_starts_with($class, $prefix)) {
      return;
    }

    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/src/' . str_replace('\\', '/', $relative) . '.php';

    if (is_readable($path)) {
      require_once $path;
    }
  });
}

use CloakWP\MediaLibraryState\MediaLibraryState;

/**
 * Deferred default boot: theme/mu-plugin fluent config can call register()
 * before init. If nothing has booted by init priority 1, start with defaults.
 */
add_action('init', static function (): void {
  if (!MediaLibraryState::booted()) {
    MediaLibraryState::make()->register();
  }
}, 1);
