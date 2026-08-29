# Media Library State

WordPress Media Library state that survives the things that usually wipe it: reloading the grid, closing an attachment details modal, and reopening a media picker after you’ve already hit **Load more** a bunch of times.

If you’ve ever scrolled five hundred images deep in an ACF image field, picked something, closed the modal, decided it was wrong, opened it again — and found yourself back at the top with all the previously loaded images gone — this is for that. Same pain shows up with galleries, featured image, and Gutenberg media pickers. The grid on `upload.php` has a milder version of it: filters and Load more depth disappear on refresh.

Configured in PHP. No settings UI, no admin notices, no premium upsells.

## What it does

### Media Library grid (`upload.php`)

- Each **Load more** writes `?media_pages=N` into the current tab URL via `history.replaceState` (no Back-button spam).
- Active filters (type, date, search, and custom filters created via `cloakwp/core` package's `LibraryFilters`) are kept in the same URL alongside `media_pages`.
- Reloading the tab — or opening the URL elsewhere — restores filters and fetches the previously loaded depth in one request, then **Load more** continues from there.
- When `media_pages > 1` after a reload, the page scrolls to the bottom (where Load more lives).
- Clicking an item (opening the attachment modal) still appends `?item={id}` to the URL (core behaviour); closing that modal restores your prior grid URL params (filters + `media_pages`), instead of core’s bare `upload.php` / `?search=` reset.

### Media modals (block editor, ACF, featured image)

Opening the Media Library from Gutenberg, an ACF Image / Gallery / File field, or Featured Image remembers the following, **per instance**, for the current editor session:

- **Load more** depth
- Active library filters
- Scroll-to-selection on reopen: featured image scrolls to the current featured attachment; ACF galleries scroll to the last selected image; image fields scroll to their current value when set

Instances are scoped so they don’t bleed into each other:

| Opener | Scope |
| --- | --- |
| ACF Image / Gallery / File | That field instance (repeater / flexible rows included) |
| Featured image | One shared `featured-image` key |
| Other Gutenberg / `wp.media` pickers | Selected block `clientId`, or a generic `select` fallback |

State is in-memory for the editor session. It does not survive a full page reload of the editor.

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

If you never call `MediaLibraryState::make()->register()`, the plugin bootstrap starts with defaults on `init` priority 1. See [Fluent API](#fluent-api) for optional config.

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
  ->persistUrl(true)         // write media_pages + filters into the grid URL
  ->persistModals(true)      // remember Load more / filters / scroll per modal instance
  ->register();
```

### Config filter

```php
add_filter('cloakwp/media-library-state/config', function ($config) {
  return $config->withMaxPages(5);
});
```

## How restore works

Media Library loads in pages (typically 80 items). Reopening at “page 5” by clicking Load more four times is slow and fragile. Instead, the first `query-attachments` request is inflated to `posts_per_page × N`, then the per-page size is restored so subsequent **Load more** calls page normally.

On the grid, `N` comes from `?media_pages=`. In modals, `N` comes from the in-memory map for that instance key.

## Out of scope

- List-view pagination (core already has `paged`)
- Persisting modal state across full editor reloads

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
