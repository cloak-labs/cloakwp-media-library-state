/**
 * Media Library State — persist Load more depth + upload.php filters.
 *
 * - upload.php grid: media_pages + filter props in the URL via history.replaceState;
 *   when media_pages > 1 after reload, scroll to the bottom of the grid
 * - Media modals (Gutenberg / ACF / featured image): per-instance in-memory pages + scroll + filters
 *
 * Restore strategy: inflate the first query-attachments request to posts_per_page * N,
 * then restore the original per-page size so subsequent more() calls page correctly.
 */
(function (window, $) {
  'use strict';

  var settings = window.mediaLibraryState || null;
  if (!settings) {
    return;
  }

  var queryVar = settings.queryVar || 'media_pages';
  var maxPages = Math.max(1, parseInt(settings.maxPages, 10) || 10);
  var persistUrl = settings.persistUrl !== false;
  var persistModals = settings.persistModals !== false;
  var isUploadScreen = !!settings.isUploadScreen;

  /** Core upload.php params we never treat as media filters. */
  var RESERVED_URL_PARAMS = {
    mode: true,
    item: true,
    action: true,
    paged: true,
    post_type: true,
    filter_action: true,
    _wpnonce: true,
    _wp_http_referer: true,
  };
  RESERVED_URL_PARAMS[queryVar] = true;

  /** @type {Map<string, {pages:number, scrollTop:number, queryProps:Object, fingerprint:string}>} */
  var modalStates = new Map();

  /** Active modal instance key while a select/featured frame is open. */
  var activeModalKey = null;

  /** Fingerprint of the manage-screen query currently reflected in the URL. */
  var manageFingerprint = null;

  /** Filter param keys we last wrote (so we can clear stale ones). */
  var managedFilterKeys = [];

  /** Skip writing the URL while applying restored filters. */
  var suppressUrlWrite = false;

  /** Keys already restored this modal open (inflate once per open). */
  var restoredThisOpen = Object.create(null);

  /** Last ACF field element clicked — for instance-scoped keys. */
  var lastAcfFieldEl = null;

  /** Pending scroll restore (modals: exact top; manage: bottom). */
  var pendingScroll = null;

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function clampPages(n) {
    n = parseInt(n, 10) || 1;
    if (n < 1) {
      return 1;
    }
    if (n > maxPages) {
      return maxPages;
    }
    return n;
  }

  function readUrlPages() {
    try {
      var params = new URLSearchParams(window.location.search);
      return clampPages(params.get(queryVar) || 1);
    } catch (e) {
      return 1;
    }
  }

  function coerceFilterValue(key, value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    if (
      key === 'year' ||
      key === 'monthnum' ||
      key === 'uploadedTo' ||
      key === 'author' ||
      key === 'parent' ||
      key === 'menuOrder'
    ) {
      var num = parseInt(value, 10);
      return isNaN(num) ? value : num;
    }
    return value;
  }

  /**
   * Props that define the attachment listing (exclude refresh / sort noise).
   */
  function pickQueryProps(props) {
    var out = {};
    if (!props) {
      return out;
    }
    var source =
      typeof props.toJSON === 'function'
        ? props.toJSON()
        : typeof props === 'object'
          ? props
          : {};
    Object.keys(source).forEach(function (key) {
      if (
        key === 'ignore' ||
        key === 'order' ||
        key === 'orderby' ||
        key === 'queryOrderbyCache' ||
        key === 'menuOrder'
      ) {
        return;
      }
      var val = source[key];
      if (val === null || val === undefined || val === '' || val === false) {
        return;
      }
      out[key] = val;
    });
    return out;
  }

  function fingerprintProps(props) {
    var picked = pickQueryProps(props);
    var keys = Object.keys(picked).sort();
    return keys
      .map(function (key) {
        return key + '=' + JSON.stringify(picked[key]);
      })
      .join('&');
  }

  function fingerprintQuery(query) {
    if (query && query.props) {
      return fingerprintProps(query.props);
    }
    if (query && query.args) {
      return fingerprintProps(query.args);
    }
    return '';
  }

  function readUrlFilters() {
    var filters = {};
    try {
      var params = new URLSearchParams(window.location.search);
      params.forEach(function (value, key) {
        if (RESERVED_URL_PARAMS[key]) {
          return;
        }
        var coerced = coerceFilterValue(key, value);
        if (coerced === null) {
          return;
        }
        filters[key] = coerced;
      });
    } catch (e) {
      // Ignore.
    }
    return filters;
  }

  function writeManageUrl(pages, propsSource) {
    if (!persistUrl || !isUploadScreen || activeModalKey || !window.history || !history.replaceState) {
      return;
    }
    if (suppressUrlWrite) {
      return;
    }
    try {
      var url = new URL(window.location.href);
      var props = pickQueryProps(propsSource);

      managedFilterKeys.forEach(function (key) {
        url.searchParams.delete(key);
      });
      managedFilterKeys = [];

      Object.keys(props).forEach(function (key) {
        if (RESERVED_URL_PARAMS[key]) {
          return;
        }
        url.searchParams.set(key, String(props[key]));
        managedFilterKeys.push(key);
      });

      pages = clampPages(pages);
      if (pages <= 1) {
        url.searchParams.delete(queryVar);
      } else {
        url.searchParams.set(queryVar, String(pages));
      }

      history.replaceState(null, '', url.toString());
    } catch (e) {
      // Ignore malformed URLs.
    }
  }

  function isManageContext() {
    return isUploadScreen && persistUrl && !activeModalKey;
  }

  function getAttachmentsScroller($root) {
    var $scope = $root && $root.length ? $root : $(document);
    var $el = $scope.find('.attachments-browser .attachments').first();
    if (!$el.length) {
      $el = $scope.find('.media-frame .attachments').first();
    }
    return $el;
  }

  function scheduleScrollRestore(scrollTop, $root) {
    if (typeof scrollTop !== 'number' || scrollTop <= 0) {
      return;
    }
    pendingScroll = { mode: 'top', scrollTop: scrollTop, $root: $root || null };
    window.setTimeout(applyPendingScroll, 50);
    window.setTimeout(applyPendingScroll, 250);
    window.setTimeout(applyPendingScroll, 600);
  }

  function scheduleScrollToBottom($root) {
    pendingScroll = { mode: 'bottom', $root: $root || null, attempts: 0 };
    window.setTimeout(applyPendingScroll, 50);
    window.setTimeout(applyPendingScroll, 250);
    window.setTimeout(applyPendingScroll, 600);
    window.setTimeout(applyPendingScroll, 1200);
  }

  function applyPendingScroll() {
    if (!pendingScroll) {
      return;
    }
    var $el = getAttachmentsScroller(pendingScroll.$root);
    if (!$el.length) {
      return;
    }

    if (pendingScroll.mode === 'bottom') {
      var height = $el.prop('scrollHeight') || 0;
      $el.scrollTop(height);
      pendingScroll.attempts = (pendingScroll.attempts || 0) + 1;
      if (height > ($el.innerHeight() || 0) + 40 || pendingScroll.attempts >= 4) {
        pendingScroll = null;
      }
      return;
    }

    $el.scrollTop(pendingScroll.scrollTop);
    if ($el.prop('scrollHeight') > pendingScroll.scrollTop + 40) {
      pendingScroll = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Instance keys                                                      */
  /* ------------------------------------------------------------------ */

  function getSelectedBlockClientId() {
    try {
      if (!window.wp || !wp.data || typeof wp.data.select !== 'function') {
        return null;
      }
      var editor = wp.data.select('core/block-editor');
      if (!editor || typeof editor.getSelectedBlock !== 'function') {
        return null;
      }
      var block = editor.getSelectedBlock();
      return block && block.clientId ? String(block.clientId) : null;
    } catch (e) {
      return null;
    }
  }

  function isFeaturedImageFrame(frame) {
    try {
      if (
        window.wp &&
        wp.media &&
        wp.media.featuredImage &&
        typeof wp.media.featuredImage.frame === 'function'
      ) {
        return wp.media.featuredImage.frame() === frame;
      }
    } catch (e) {
      // Fall through.
    }
    return false;
  }

  function resolveModalKey(frame, acfPopup) {
    if (acfPopup && typeof acfPopup.get === 'function') {
      var fieldKey = acfPopup.get('field') || '';
      var instanceId = '';
      if (lastAcfFieldEl) {
        instanceId =
          lastAcfFieldEl.getAttribute('data-id') ||
          lastAcfFieldEl.getAttribute('data-key') ||
          '';
      }
      return 'acf:' + String(fieldKey) + ':' + String(instanceId || fieldKey);
    }

    if (isFeaturedImageFrame(frame)) {
      return 'featured-image';
    }

    var clientId = getSelectedBlockClientId();
    if (clientId) {
      return 'block:' + clientId;
    }

    return 'select';
  }

  /* ------------------------------------------------------------------ */
  /* Desired pages for a Query                                          */
  /* ------------------------------------------------------------------ */

  function getDesiredPages(query) {
    var fingerprint = fingerprintQuery(query);

    if (isManageContext()) {
      if (manageFingerprint === null) {
        manageFingerprint = fingerprint;
        return readUrlPages();
      }
      if (fingerprint !== manageFingerprint) {
        manageFingerprint = fingerprint;
        writeManageUrl(1, query.props);
        return 1;
      }
      // Same listing (e.g. ignore refresh) — stay at current URL depth.
      return readUrlPages();
    }

    if (!persistModals || !activeModalKey) {
      return 1;
    }

    var saved = modalStates.get(activeModalKey);
    if (!saved || !saved.pages || saved.pages <= 1) {
      return 1;
    }

    // Filters differ from what we saved.
    if (saved.fingerprint && saved.fingerprint !== fingerprint) {
      // First query after open may run before we re-apply saved props —
      // do not wipe state; the follow-up query should match and inflate.
      if (!restoredThisOpen[activeModalKey]) {
        return 1;
      }
      // User changed filters after restore — reset this instance.
      modalStates.set(activeModalKey, {
        pages: 1,
        scrollTop: 0,
        queryProps: pickQueryProps(query.props),
        fingerprint: fingerprint,
      });
      return 1;
    }

    if (restoredThisOpen[activeModalKey]) {
      return 1;
    }
    restoredThisOpen[activeModalKey] = true;
    return clampPages(saved.pages);
  }

  function persistAfterLoad(query, pages) {
    pages = clampPages(pages);

    if (isManageContext()) {
      writeManageUrl(pages, query.props);
      if (pages > 1) {
        scheduleScrollToBottom(null);
      }
      return;
    }

    if (!persistModals || !activeModalKey) {
      return;
    }

    var prev = modalStates.get(activeModalKey) || {};
    modalStates.set(activeModalKey, {
      pages: pages,
      scrollTop: typeof prev.scrollTop === 'number' ? prev.scrollTop : 0,
      queryProps: pickQueryProps(query.props),
      fingerprint: fingerprintQuery(query),
    });
  }

  function pagesFromLength(query) {
    var perPage =
      (query._mls && query._mls.originalPerPage) ||
      (query.args && query.args.posts_per_page) ||
      80;
    perPage = parseInt(perPage, 10) || 80;
    if (perPage <= 0) {
      return 1;
    }
    return clampPages(Math.max(1, Math.ceil(query.length / perPage)));
  }

  /* ------------------------------------------------------------------ */
  /* Patch wp.media.model.Query                                         */
  /* ------------------------------------------------------------------ */

  function ensureQueryPatch() {
    if (!window.wp || !wp.media || !wp.media.model || !wp.media.model.Query) {
      return false;
    }
    if (wp.media.model.Query.prototype._mediaLibraryStatePatched) {
      return true;
    }

    var proto = wp.media.model.Query.prototype;
    var originalSync = proto.sync;
    var originalMore = proto.more;

    proto.sync = function (method, model, options) {
      if (method === 'read' && this.length === 0 && !this._mls) {
        var perPage = (this.args && this.args.posts_per_page) || 80;
        perPage = parseInt(perPage, 10) || 80;
        var pages = getDesiredPages(this);
        this._mls = {
          originalPerPage: perPage,
          inflatedPages: pages > 1 ? pages : 0,
        };
        if (pages > 1 && perPage > 0) {
          this.args.posts_per_page = perPage * pages;
        }
      }

      var result = originalSync.apply(this, arguments);

      if (this._mls && this._mls.inflatedPages && method === 'read') {
        var query = this;
        var inflatedPages = this._mls.inflatedPages;
        var originalPerPage = this._mls.originalPerPage;
        this._mls.inflatedPages = 0;

        if (result && typeof result.done === 'function') {
          result.done(function (resp) {
            query.args.posts_per_page = originalPerPage;
            var len = Array.isArray(resp) ? resp.length : query.length;
            if (!resp || len < originalPerPage * inflatedPages) {
              query._hasMore = false;
            } else {
              query._hasMore = true;
            }
            persistAfterLoad(query, pagesFromLength(query));
          });
        }
      }

      return result;
    };

    proto.more = function (options) {
      var query = this;
      var promise = originalMore.apply(this, arguments);
      if (promise && typeof promise.done === 'function') {
        promise.done(function () {
          var pages = pagesFromLength(query);
          persistAfterLoad(query, pages);
        });
      }
      return promise;
    };

    proto._mediaLibraryStatePatched = true;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Manage screen: restore filters from URL before first query         */
  /* ------------------------------------------------------------------ */

  function restoreSearchInput(search) {
    if (!search) {
      return;
    }
    var $input = $('#media-search-input');
    if ($input.length) {
      $input.val(search);
    }
  }

  function onManagePropsChange() {
    if (suppressUrlWrite || !isManageContext()) {
      return;
    }
    var props = this;
    var fingerprint = fingerprintProps(props);
    if (fingerprint !== manageFingerprint) {
      manageFingerprint = fingerprint;
      writeManageUrl(1, props);
    } else {
      writeManageUrl(readUrlPages(), props);
    }
  }

  function applyManageFiltersFromUrl(library) {
    if (!library || !library.props || typeof library.props.set !== 'function') {
      return;
    }

    var filters = readUrlFilters();
    managedFilterKeys = Object.keys(filters);

    if (Object.keys(filters).length) {
      suppressUrlWrite = true;
      library.props.set(filters);
      suppressUrlWrite = false;
    }

    manageFingerprint = fingerprintProps(library.props);

    if (typeof library.props.off === 'function') {
      library.props.off('change.mediaLibraryState');
    }
    library.props.on('change.mediaLibraryState', onManagePropsChange);

    if (filters.search) {
      window.setTimeout(function () {
        restoreSearchInput(filters.search);
      }, 0);
    }
  }

  function patchManageFrame() {
    if (!isUploadScreen || !persistUrl) {
      return false;
    }
    if (!window.wp || !wp.media || !wp.media.view || !wp.media.view.MediaFrame) {
      return false;
    }
    var Manage = wp.media.view.MediaFrame.Manage;
    if (!Manage || !Manage.prototype) {
      return false;
    }
    if (Manage.prototype._mediaLibraryStatePatched) {
      return true;
    }

    var originalInitialize = Manage.prototype.initialize;
    Manage.prototype.initialize = function () {
      originalInitialize.apply(this, arguments);

      var state = typeof this.state === 'function' ? this.state() : null;
      var library = state && typeof state.get === 'function' ? state.get('library') : null;
      if (library) {
        applyManageFiltersFromUrl(library);
      }

      this.on('content:activate:browse', function () {
        var browser = null;
        try {
          browser = this.content.get();
        } catch (e) {
          return;
        }
        if (!browser || !browser.collection) {
          return;
        }
        if (manageFingerprint === null) {
          applyManageFiltersFromUrl(browser.collection);
        }
        var search = browser.collection.props && browser.collection.props.get('search');
        restoreSearchInput(search);
      });
    };

    Manage.prototype._mediaLibraryStatePatched = true;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Modal frame binding                                                */
  /* ------------------------------------------------------------------ */

  function applyModalQueryProps(frame, queryProps) {
    if (!queryProps || !Object.keys(queryProps).length) {
      return;
    }
    try {
      var state = frame.state();
      var library = state && typeof state.get === 'function' ? state.get('library') : null;
      if (!library || !library.props || typeof library.props.set !== 'function') {
        return;
      }
      library.props.set(queryProps);
    } catch (e) {
      // Frame not ready.
    }
  }

  function bindModalFrame(frame, acfPopup) {
    if (!frame || frame._mediaLibraryStateBound || typeof frame.on !== 'function') {
      return;
    }
    frame._mediaLibraryStateBound = true;

    frame.on('open', function () {
      if (!persistModals) {
        return;
      }

      activeModalKey = resolveModalKey(frame, acfPopup || null);
      restoredThisOpen = Object.create(null);

      var saved = modalStates.get(activeModalKey);
      if (saved && saved.queryProps && Object.keys(saved.queryProps).length) {
        // Re-apply filters before the browse query so fingerprint matches.
        window.setTimeout(function () {
          applyModalQueryProps(frame, saved.queryProps);
        }, 0);
      }

      if (saved && typeof saved.scrollTop === 'number' && saved.scrollTop > 0) {
        scheduleScrollRestore(saved.scrollTop, frame.$el);
      }
    });

    frame.on('close', function () {
      if (!persistModals || !activeModalKey) {
        activeModalKey = null;
        return;
      }

      var $scroller = getAttachmentsScroller(frame.$el);
      var scrollTop = $scroller.length ? $scroller.scrollTop() : 0;
      var prev = modalStates.get(activeModalKey) || {
        pages: 1,
        queryProps: {},
        fingerprint: '',
      };
      modalStates.set(activeModalKey, {
        pages: prev.pages || 1,
        scrollTop: scrollTop,
        queryProps: prev.queryProps || {},
        fingerprint: prev.fingerprint || '',
      });

      activeModalKey = null;
    });
  }

  function patchMediaFactory() {
    if (!window.wp || !wp.media || wp.media._mediaLibraryStatePatched) {
      return !!ensureQueryPatch();
    }

    var originalMedia = wp.media;
    wp.media = function (attributes) {
      var frame = originalMedia.apply(this, arguments);
      if (frame) {
        bindModalFrame(frame, null);
      }
      return frame;
    };
    $.extend(wp.media, originalMedia);
    wp.media._mediaLibraryStatePatched = true;

    ensureQueryPatch();
    return true;
  }

  function bindAcfPopups() {
    if (!window.acf || typeof acf.addAction !== 'function') {
      return false;
    }
    if (window._mediaLibraryStateAcfBound) {
      return true;
    }
    window._mediaLibraryStateAcfBound = true;

    $(document).on(
      'mousedown.mediaLibraryState',
      '.acf-field[data-type="image"], .acf-field[data-type="gallery"], .acf-field[data-type="file"]',
      function () {
        lastAcfFieldEl = this;
      }
    );

    acf.addAction('new_media_popup', function (popup) {
      ensureQueryPatch();
      if (popup && popup.frame) {
        bindModalFrame(popup.frame, popup);
      }
    });

    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  function boot() {
    managedFilterKeys = Object.keys(readUrlFilters());
    ensureQueryPatch();
    patchManageFrame();
    patchMediaFactory();
    bindAcfPopups();

    // Reload with media_pages already set — scroll once attachments inflate.
    if (isUploadScreen && readUrlPages() > 1) {
      scheduleScrollToBottom(null);
    }
  }

  if (!ensureQueryPatch()) {
    $(boot);
  } else {
    patchManageFrame();
    patchMediaFactory();
    bindAcfPopups();
  }

  $(function () {
    boot();
  });
})(window, jQuery);
