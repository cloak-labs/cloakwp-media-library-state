<?php

declare(strict_types=1);

namespace CloakWP\MediaLibraryState\Tests;

use CloakWP\MediaLibraryState\Core\Config;
use CloakWP\MediaLibraryState\MediaLibraryState;
use PHPUnit\Framework\TestCase;

final class MediaLibraryStateFacadeTest extends TestCase
{
  public function testDefaults(): void
  {
    $config = Config::defaults();

    $this->assertSame('media_pages', $config->queryVar);
    $this->assertSame(10, $config->maxPages);
    $this->assertTrue($config->persistUrl);
    $this->assertTrue($config->persistModals);
    $this->assertFalse(MediaLibraryState::booted());
  }

  public function testFluentConfig(): void
  {
    $instance = MediaLibraryState::make()
      ->queryVar('pages_loaded')
      ->maxPages(5)
      ->persistUrl(false)
      ->persistModals(false);

    $config = $instance->config();

    $this->assertSame('pages_loaded', $config->queryVar);
    $this->assertSame(5, $config->maxPages);
    $this->assertFalse($config->persistUrl);
    $this->assertFalse($config->persistModals);
    $this->assertFalse(MediaLibraryState::booted());
  }

  public function testMaxPagesClampsToAtLeastOne(): void
  {
    $config = Config::defaults()->withMaxPages(0);

    $this->assertSame(1, $config->maxPages);
  }

  public function testEmptyQueryVarFallsBackToDefault(): void
  {
    $config = Config::defaults()->withQueryVar('');

    $this->assertSame('media_pages', $config->queryVar);
  }
}
