# Media Library State

Remember where you are in the WordPress Media Library. **Load more** depth survives page reloads on the grid, and media modal reopenings in the block editor / ACF fields.

Configured in PHP, no settings UI, no admin notices, no premium upsells.

## Install paths

### 1. Composer (must-use plugin) — recommended

```bash
composer require cloakwp/media-library-state
```

Package type is `wordpress-muplugin`. With [`composer/installers`](https://github.com/composer/installers) configured, that installs to:

```
wp-content/mu-plugins/media-library-state/
```

(Your project may map that path differently — e.g. Bedrock uses `public/app/mu-plugins/`.)

**Important:** WordPress core only auto-loads PHP files directly in `mu-plugins/`. It does **not** load plugins nested in subdirectories like `mu-plugins/media-library-state/media-library-state.php`. You need an autoloader (or a tiny stub) for subdirectory must-use plugins.

**Recommended:** [Roots Bedrock Autoloader](https://github.com/roots/bedrock-autoloader) — it scans `mu-plugins/*/*.php` for plugin headers and includes them. Ships with [Bedrock](https://roots.io/bedrock/); usable in any WordPress project as `roots/bedrock-autoloader`. Once loaded, this package shows under **Plugins → Must-Use** (not the toggleable Plugins list).

**Without an autoloader**, add a one-line stub at the mu-plugins root:

```php
<?php
// wp-content/mu-plugins/media-library-state-loader.php
require WPMU_PLUGIN_DIR . '/media-library-state/media-library-state.php';
```

Optional fluent config in your theme `functions.php` (runs before the deferred default boot):

```php
use CloakWP\MediaLibraryState\MediaLibraryState;

MediaLibraryState::make()
  ->maxPages(10)
  ->register();
```

If you never call `register()`, the plugin bootstrap starts with defaults on `init` priority 1.

### 2. Traditional plugin install (download as a zip)

For sites that don’t use Composer — install it like any other WordPress plugin:

1. Open the [GitHub repository page](https://github.com/cloak-labs/cloakwp-media-library-state).
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip the file. You’ll get a folder named something like `cloakwp-media-library-state-main`.
4. Rename that folder to `media-library-state` (optional but keeps the Plugins list tidy).
5. Install it in either way:
   - **WordPress admin:** Plugins → Add New → Upload Plugin → choose the zip (re-zip the renamed folder if you renamed it) → Install Now → Activate, **or**
   - **Manually:** upload the `media-library-state` folder into `wp-content/plugins/` on your server (via FTP/SFTP or your host’s file manager), then go to Plugins and click **Activate**.

Same defaults as the Composer path. Developers can still override config via fluent `register()` or the config filter (below). No mu-plugin autoloader needed.

## Fluent API

```php
MediaLibraryState::make()
  ->queryVar('media_pages')  // URL param on upload.php grid
  ->maxPages(10)             // cap restored first-query size (pages × 80 items)
  ->persistUrl(true)         // write media_pages into the grid URL
  ->persistModals(true)      // remember Load more depth per modal instance
  ->register();
```

### Config filter

```php
add_filter('cloakwp/media-library-state/config', function ($config) {
  return $config->withMaxPages(5);
});
```

## What it does

### Media Library grid (`upload.php`)

Each **Load more** updates the current tab URL with `?media_pages=N` via `history.replaceState` (no Back-button spam). Active filters (type, date, search, and custom CloakWP filters such as orientation / media categories) are written into the same URL. Reloading the same tab — or opening the URL in a new tab — restores those filters and fetches all previously loaded pages in one request, then continues from there.

When `media_pages` is greater than 1 after a reload, the grid scrolls to the bottom (where Load more lives).

### Media modals (block editor, ACF Image/Gallery/File)

Opening the Media Library from a Gutenberg image block, ACF field, or featured image remembers **Load more** depth, scroll, and active filters for that instance in memory for the current editor session. Opening the picker for a *different* block or field starts fresh (or restores that instance’s own state).

State does not survive a full editor reload (Gutenberg regenerates block `clientId`s).

### Out of scope (MVP)

- List-view pagination (core already has `paged`)
- Selected attachment (core already has `item=`)

## Architecture

```
src/Core/              # Config
src/Plugin/            # Assets enqueue
MediaLibraryState.php  # Fluent facade
resources/js/          # Query inflate + URL / modal persistence
```

## Development

```bash
composer install
composer test
```

## License

LGPL-3.0-only
