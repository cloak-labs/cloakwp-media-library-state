<?php

declare(strict_types=1);

namespace CloakWP\MediaLibraryState\Plugin;

use CloakWP\MediaLibraryState\Core\Config;

/**
 * WordPress integration layer (admin JS enqueue).
 */
final class Plugin
{
  public function __construct(
    private readonly Config $config,
    private readonly string $pluginFile,
  ) {
  }

  public function boot(): void
  {
    (new Assets($this->config, $this->pluginFile))->register();
  }
}
