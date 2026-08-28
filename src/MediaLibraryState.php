<?php

declare(strict_types=1);

namespace CloakWP\MediaLibraryState;

use CloakWP\MediaLibraryState\Core\Config;
use CloakWP\MediaLibraryState\Plugin\Plugin;
use InvalidArgumentException;

/**
 * Fluent entry point for Media Library State.
 *
 * @example
 * MediaLibraryState::make()
 *   ->queryVar('media_pages')
 *   ->maxPages(10)
 *   ->register();
 */
final class MediaLibraryState
{
  private static ?self $instance = null;

  private Config $config;
  private bool $registered = false;
  private ?Plugin $plugin = null;

  private function __construct(Config $config)
  {
    $this->config = $config;
  }

  public static function make(): self
  {
    return new self(Config::defaults());
  }

  public static function booted(): bool
  {
    return self::$instance !== null && self::$instance->registered;
  }

  public static function instance(): ?self
  {
    return self::$instance;
  }

  public function queryVar(string $queryVar): self
  {
    $this->assertMutable();
    $this->config = $this->config->withQueryVar($queryVar);

    return $this;
  }

  public function maxPages(int $maxPages): self
  {
    $this->assertMutable();
    $this->config = $this->config->withMaxPages($maxPages);

    return $this;
  }

  public function persistUrl(bool $persistUrl = true): self
  {
    $this->assertMutable();
    $this->config = $this->config->withPersistUrl($persistUrl);

    return $this;
  }

  public function persistModals(bool $persistModals = true): self
  {
    $this->assertMutable();
    $this->config = $this->config->withPersistModals($persistModals);

    return $this;
  }

  public function config(): Config
  {
    return $this->config;
  }

  /**
   * Boot WordPress integration (admin JS).
   */
  public function register(): self
  {
    if ($this->registered) {
      return $this;
    }

    if (self::$instance !== null && self::$instance->registered && self::$instance !== $this) {
      throw new InvalidArgumentException(
        'Media Library State is already registered. Call MediaLibraryState::make()->…->register() only once.'
      );
    }

    /** @var Config $config */
    $config = apply_filters('cloakwp/media-library-state/config', $this->config);
    $this->config = $config;

    $pluginFile = defined('CLOAKWP_MEDIA_LIBRARY_STATE_FILE')
      ? CLOAKWP_MEDIA_LIBRARY_STATE_FILE
      : dirname(__DIR__) . '/media-library-state.php';

    $this->plugin = new Plugin($this->config, $pluginFile);
    $this->plugin->boot();

    $this->registered = true;
    self::$instance = $this;

    return $this;
  }

  private function assertMutable(): void
  {
    if ($this->registered) {
      throw new InvalidArgumentException('Cannot change Media Library State config after register().');
    }
  }
}
