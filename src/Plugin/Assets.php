<?php

declare(strict_types=1);

namespace CloakWP\MediaLibraryState\Plugin;

use CloakWP\MediaLibraryState\Core\Config;

/**
 * Registers and enqueues the media library state script.
 */
final class Assets
{
  public const SCRIPT_HANDLE = 'media-library-state';

  private bool $localized = false;

  public function __construct(
    private readonly Config $config,
    private readonly string $pluginFile,
  ) {
  }

  public function register(): void
  {
    add_action('admin_enqueue_scripts', [$this, 'registerHandles'], 1);
    add_action('admin_enqueue_scripts', [$this, 'enqueueOnAdminScreens'], 20);
    add_action('wp_enqueue_media', [$this, 'enqueue'], 20);
    add_action('acf/input/admin_enqueue_scripts', [$this, 'enqueueForAcf'], 20);
  }

  public function registerHandles(): void
  {
    $version = defined('CLOAKWP_MEDIA_LIBRARY_STATE_VERSION')
      ? CLOAKWP_MEDIA_LIBRARY_STATE_VERSION
      : '0.1.0';

    $jsPath = $this->path('resources/js/media-library-state.js');
    if (!is_readable($jsPath)) {
      return;
    }

    $jsUrl = $this->url('resources/js/media-library-state.js');
    $jsVersion = $version . '.' . (string) filemtime($jsPath);

    // Patch Query before wp-admin `media` creates the Manage frame on ready.
    // Do NOT depend on `media` — that would place us after its ready handler.
    $deps = ['jquery', 'media-models', 'media-views'];
    if (wp_script_is('media-grid', 'registered') || wp_script_is('media-grid', 'enqueued')) {
      $deps[] = 'media-grid';
    }

    if (wp_script_is(self::SCRIPT_HANDLE, 'registered')) {
      $scripts = wp_scripts();
      $scripts->registered[self::SCRIPT_HANDLE]->src = $jsUrl;
      $scripts->registered[self::SCRIPT_HANDLE]->deps = $deps;
      $scripts->registered[self::SCRIPT_HANDLE]->ver = $jsVersion;
    } else {
      wp_register_script(self::SCRIPT_HANDLE, $jsUrl, $deps, $jsVersion, true);
    }
  }

  public function enqueueOnAdminScreens(string $hookSuffix): void
  {
    if (!in_array($hookSuffix, ['upload.php', 'post.php', 'post-new.php', 'media-upload.php', 'attachment'], true)) {
      return;
    }

    $this->registerHandles();
    $this->enqueue();
  }

  public function enqueueForAcf(): void
  {
    if (function_exists('wp_enqueue_media')) {
      wp_enqueue_media();
    }
    $this->enqueue();
  }

  public function enqueue(): void
  {
    if (!wp_script_is(self::SCRIPT_HANDLE, 'registered')) {
      $this->registerHandles();
    }

    if (!wp_script_is(self::SCRIPT_HANDLE, 'registered')) {
      return;
    }

    wp_enqueue_script(self::SCRIPT_HANDLE);
    $this->localize();
  }

  private function localize(): void
  {
    if ($this->localized || !wp_script_is(self::SCRIPT_HANDLE, 'registered')) {
      return;
    }

    wp_localize_script(self::SCRIPT_HANDLE, 'mediaLibraryState', [
      'queryVar' => $this->config->queryVar,
      'maxPages' => $this->config->maxPages,
      'persistUrl' => $this->config->persistUrl,
      'persistModals' => $this->config->persistModals,
      'isUploadScreen' => $this->isUploadScreen(),
    ]);

    $this->localized = true;
  }

  private function isUploadScreen(): bool
  {
    global $pagenow;

    return is_admin() && isset($pagenow) && $pagenow === 'upload.php';
  }

  private function url(string $relative): string
  {
    $relative = ltrim($relative, '/');
    $base = plugins_url('', $this->pluginFile);

    // Symlink safety net: plugins_url() can emit /app/plugins/var/www/... when
    // the package realpath sits outside wp-content.
    if (defined('WPMU_PLUGIN_URL') && (str_contains($base, '/var/www/') || str_contains($base, '/plugins/var/'))) {
      $base = trailingslashit(WPMU_PLUGIN_URL) . 'media-library-state';
    }

    return trailingslashit($base) . $relative;
  }

  private function path(string $relative): string
  {
    $dir = defined('CLOAKWP_MEDIA_LIBRARY_STATE_DIR')
      ? CLOAKWP_MEDIA_LIBRARY_STATE_DIR
      : dirname($this->pluginFile);

    $real = realpath($dir);
    if ($real !== false) {
      $dir = $real;
    }

    return rtrim($dir, '/\\') . '/' . ltrim($relative, '/');
  }
}
