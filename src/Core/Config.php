<?php

declare(strict_types=1);

namespace CloakWP\MediaLibraryState\Core;

/**
 * Immutable configuration for Media Library State.
 */
final class Config
{
  public const DEFAULT_QUERY_VAR = 'media_pages';
  public const DEFAULT_MAX_PAGES = 10;

  public function __construct(
    public readonly string $queryVar,
    public readonly int $maxPages,
    public readonly bool $persistUrl,
    public readonly bool $persistModals,
  ) {
  }

  public static function defaults(): self
  {
    return new self(
      queryVar: self::DEFAULT_QUERY_VAR,
      maxPages: self::DEFAULT_MAX_PAGES,
      persistUrl: true,
      persistModals: true,
    );
  }

  public function withQueryVar(string $queryVar): self
  {
    $queryVar = sanitize_key($queryVar);
    if ($queryVar === '') {
      $queryVar = self::DEFAULT_QUERY_VAR;
    }

    return new self(
      queryVar: $queryVar,
      maxPages: $this->maxPages,
      persistUrl: $this->persistUrl,
      persistModals: $this->persistModals,
    );
  }

  public function withMaxPages(int $maxPages): self
  {
    return new self(
      queryVar: $this->queryVar,
      maxPages: max(1, $maxPages),
      persistUrl: $this->persistUrl,
      persistModals: $this->persistModals,
    );
  }

  public function withPersistUrl(bool $persistUrl): self
  {
    return new self(
      queryVar: $this->queryVar,
      maxPages: $this->maxPages,
      persistUrl: $persistUrl,
      persistModals: $this->persistModals,
    );
  }

  public function withPersistModals(bool $persistModals): self
  {
    return new self(
      queryVar: $this->queryVar,
      maxPages: $this->maxPages,
      persistUrl: $this->persistUrl,
      persistModals: $persistModals,
    );
  }
}
