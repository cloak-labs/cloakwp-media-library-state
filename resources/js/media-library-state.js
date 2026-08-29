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

  /**
   * Backbone fragment for the manage grid URL (e.g. upload.php?mode=grid&media_pages=2).
   * Core EditAttachments.resetRoute navigates to bare upload.php / ?search= and would
   * otherwise drop filters + media_pages when closing an item modal.
   */
  var lastManageFragment = null;

  /** Filter param keys we last wrote (so we can clear stale ones). */
  var managedFilterKeys = [];

  /** Skip writing the URL while applying restored filters. */
  var suppressUrlWrite = false;

  /** Keys already restored this modal open (inflate once per open). */
  var restoredThisOpen = Object.create(null);

  /** Last ACF field element clicked — for instance-scoped keys. */
  var lastAcfFieldEl = null;

  /**
   * Pending modal kind from a click that opens media (e.g. featured image).
   * Consumed in resolveModalKey so Gutenberg MediaUpload frames (which are not
   * wp.media.featuredImage._frame) still get a stable key.
   */
  var pendingModalKind = null;

  /** Pending scroll restore (modals: exact top / attachment; manage: bottom). */
  var pendingScroll = null;

  /** Attachment ids to bring into view after a modal library finishes loading. */
  var pendingFocusAttachmentIds = null;

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
        key === 'menuOrder' ||
        key === 'query' ||
        key === '_acfuploader' ||
        key === queryVar
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

  function isManageGridFrame() {
    try {
      var browse = window.wp && wp.media && wp.media.frames && wp.media.frames.browse;
      return !!(
        browse &&
        wp.media.view &&
        wp.media.view.MediaFrame &&
        wp.media.view.MediaFrame.Manage &&
        browse instanceof wp.media.view.MediaFrame.Manage
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Remember the current manage-grid URL (minus ?item=) so we can restore it
   * when the attachment details modal closes.
   */
  function snapshotManageLocation(pathAndSearch) {
    if (!persistUrl || !isUploadScreen) {
      return;
    }
    try {
      var pathSearch = pathAndSearch;
      if (!pathSearch) {
        var url = new URL(window.location.href);
        if (url.searchParams.has('item')) {
          return;
        }
        pathSearch = url.pathname + url.search + url.hash;
      }
      var adminUrl =
        window._wpMediaGridSettings && _wpMediaGridSettings.adminUrl
          ? String(_wpMediaGridSettings.adminUrl)
          : '';
      if (adminUrl && pathSearch.indexOf(adminUrl) === 0) {
        lastManageFragment = pathSearch.slice(adminUrl.length);
      } else if (pathSearch.indexOf('upload.php') !== -1) {
        lastManageFragment = pathSearch.replace(/^.*?(upload\.php)/, 'upload.php');
      } else {
        lastManageFragment = 'upload.php' + (pathSearch.indexOf('?') >= 0 ? pathSearch.slice(pathSearch.indexOf('?')) : '');
      }
    } catch (e) {
      // Ignore.
    }
  }

  function fragmentToPathAndSearch(fragment) {
    var adminUrl =
      window._wpMediaGridSettings && _wpMediaGridSettings.adminUrl
        ? String(_wpMediaGridSettings.adminUrl)
        : '';
    if (!fragment) {
      return '';
    }
    if (fragment.charAt(0) === '/') {
      return fragment;
    }
    return adminUrl ? adminUrl.replace(/\/?$/, '/') + fragment.replace(/^\//, '') : '/' + fragment;
  }

  function writeManageUrl(pages, propsSource) {
    if (!persistUrl || !isUploadScreen || !window.history || !history.replaceState) {
      return;
    }
    // Only block when a real picker modal is active (not the Manage grid).
    if (activeModalKey && !isManageGridFrame()) {
      return;
    }
    if (suppressUrlWrite) {
      return;
    }
    try {
      var url = new URL(window.location.href);

      // Core Manage uses Backbone.history for ?item= / ?search= routes.
      // Never rewrite while an attachment is open — keep lastManageFragment.
      if (url.searchParams.has('item')) {
        return;
      }

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

      var pathAndSearch = url.pathname + url.search + url.hash;
      var adminUrl =
        window._wpMediaGridSettings && _wpMediaGridSettings.adminUrl
          ? String(_wpMediaGridSettings.adminUrl)
          : '';
      var fragment = pathAndSearch;
      if (adminUrl && pathAndSearch.indexOf(adminUrl) === 0) {
        fragment = pathAndSearch.slice(adminUrl.length);
      }

      snapshotManageLocation(pathAndSearch);

      // Keep Backbone's fragment in sync when Manage has started history.
      if (
        window.Backbone &&
        Backbone.History &&
        Backbone.History.started &&
        Backbone.history &&
        typeof Backbone.history.navigate === 'function'
      ) {
        Backbone.history.navigate(fragment, { replace: true, trigger: false });
      } else {
        history.replaceState(null, '', pathAndSearch);
      }
    } catch (e) {
      // Ignore malformed URLs.
    }
  }

  function isManageContext() {
    if (!isUploadScreen || !persistUrl) {
      return false;
    }
    // Standalone grid wins even if a buggy modal bind left activeModalKey set.
    if (isManageGridFrame()) {
      return true;
    }
    return !activeModalKey;
  }

  function getAttachmentsScroller($root) {
    var $scope = $root && $root.length ? $root : $(document);
    // WP 5.8+: with the Load more button, overflow is on .attachments-wrapper
    // (not .attachments). Infinite-scroll mode still scrolls .attachments.
    var $el = $scope.find('.attachments-browser.has-load-more .attachments-wrapper').first();
    if (!$el.length) {
      $el = $scope.find('.attachments-browser .attachments-wrapper').first();
    }
    if (!$el.length) {
      $el = $scope.find('.attachments-browser .attachments').first();
    }
    if (!$el.length) {
      $el = $scope.find('.media-frame .attachments').first();
    }
    return $el;
  }

  function findAttachmentEl(attachmentIds, $root) {
    var ids = normalizeAttachmentIds(attachmentIds);
    if (!ids.length) {
      return $();
    }
    var $scope =
      $root && $root.length
        ? $root
        : $('.media-modal:visible, .media-frame:visible').last();
    if (!$scope.length) {
      $scope = $(document);
    }
    // Prefer the last id (gallery: last selected; featured/image: single).
    for (var i = ids.length - 1; i >= 0; i--) {
      var $attachment = $scope.find('.attachment[data-id="' + ids[i] + '"]').first();
      if ($attachment.length) {
        return $attachment;
      }
    }
    return $();
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

  function scheduleScrollToAttachment(attachmentIds, $root) {
    var ids = normalizeAttachmentIds(attachmentIds);
    if (!ids.length) {
      return;
    }
    pendingFocusAttachmentIds = ids;
    pendingScroll = {
      mode: 'attachment',
      attachmentIds: ids,
      $root: $root || null,
      attempts: 0,
    };
    window.setTimeout(applyPendingScroll, 50);
    window.setTimeout(applyPendingScroll, 250);
    window.setTimeout(applyPendingScroll, 600);
    window.setTimeout(applyPendingScroll, 1200);
    window.setTimeout(applyPendingScroll, 2000);
    window.setTimeout(applyPendingScroll, 3500);
  }

  function normalizeAttachmentIds(ids) {
    var out = [];
    if (!ids) {
      return out;
    }
    var list = Object.prototype.toString.call(ids) === '[object Array]' ? ids : [ids];
    list.forEach(function (id) {
      if (id === null || id === undefined || id === '') {
        return;
      }
      if (typeof id === 'object' && id.id != null) {
        id = id.id;
      }
      id = String(id);
      if (id === '0' || id === '-1') {
        return;
      }
      if (out.indexOf(id) === -1) {
        out.push(id);
      }
    });
    return out;
  }

  function scrollAttachmentIntoView($scroller, $attachment) {
    if (!$scroller.length || !$attachment.length) {
      return false;
    }
    var scrollerEl = $scroller.get(0);
    var attEl = $attachment.get(0);
    if (!scrollerEl || !attEl) {
      return false;
    }

    var scrollerRect = scrollerEl.getBoundingClientRect();
    var attRect = attEl.getBoundingClientRect();
    // Skip if layout isn't ready yet (zero-size scroller).
    if (scrollerRect.height < 40) {
      return false;
    }

    var next =
      scrollerEl.scrollTop +
      (attRect.top - scrollerRect.top) -
      scrollerRect.height / 2 +
      attRect.height / 2;
    scrollerEl.scrollTop = Math.max(0, next);
    return true;
  }

  function applyPendingScroll() {
    if (!pendingScroll) {
      return;
    }

    // upload.php grid scrolls the window; modal browsers scroll .attachments.
    if (pendingScroll.mode === 'bottom' && isUploadScreen && !pendingScroll.$root) {
      var doc = document.documentElement;
      var body = document.body;
      var height = Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0);
      window.scrollTo(0, height);
      pendingScroll.attempts = (pendingScroll.attempts || 0) + 1;
      if (
        height > (window.innerHeight || 0) + 40 ||
        pendingScroll.attempts >= 4
      ) {
        pendingScroll = null;
      }
      return;
    }

    if (pendingScroll.mode === 'attachment') {
      var $attachment = findAttachmentEl(
        pendingScroll.attachmentIds,
        pendingScroll.$root
      );
      if ($attachment.length) {
        var $scroller = getAttachmentsScroller(
          pendingScroll.$root && pendingScroll.$root.length
            ? pendingScroll.$root
            : $attachment.closest('.media-frame, .media-modal')
        );
        if (!$scroller.length) {
          $scroller = $attachment.closest('.attachments-wrapper, .attachments');
        }
        if (scrollAttachmentIntoView($scroller, $attachment)) {
          pendingScroll = null;
          pendingFocusAttachmentIds = null;
          return;
        }
      }
      pendingScroll.attempts = (pendingScroll.attempts || 0) + 1;
      if (pendingScroll.attempts >= 8) {
        pendingScroll = null;
      }
      return;
    }

    var $el = getAttachmentsScroller(pendingScroll.$root);
    if (!$el.length) {
      return;
    }

    if (pendingScroll.mode === 'bottom') {
      var elHeight = $el.prop('scrollHeight') || 0;
      $el.scrollTop(elHeight);
      pendingScroll.attempts = (pendingScroll.attempts || 0) + 1;
      if (elHeight > ($el.innerHeight() || 0) + 40 || pendingScroll.attempts >= 4) {
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
    if (!frame) {
      return false;
    }
    if (frame._mlsFeaturedImage) {
      return true;
    }
    try {
      if (
        window.wp &&
        wp.media &&
        wp.media.featuredImage &&
        wp.media.featuredImage._frame === frame
      ) {
        return true;
      }
    } catch (e) {
      // Fall through.
    }
    try {
      if (frame.options && frame.options.state === 'featured-image') {
        return true;
      }
      if (
        frame.states &&
        typeof frame.states.findWhere === 'function' &&
        frame.states.findWhere({ id: 'featured-image' })
      ) {
        return true;
      }
      if (typeof frame.state === 'function') {
        var state = frame.state();
        if (state && state.id === 'featured-image') {
          return true;
        }
      }
    } catch (e) {
      // Fall through.
    }
    return false;
  }

  /**
   * Stable per-instance key for an ACF image/file/gallery field.
   * Field key alone is shared across every repeater/flexible row.
   * Prefer input name / row path over Backbone cid — empty galleries often
   * have no inputs, and cid changes when Gutenberg re-renders the block.
   */
  function buildAcfInstanceKey(fieldKey, fieldInstance) {
    var parts = ['acf'];
    var key = fieldKey || '';
    var field = fieldInstance || null;
    var el = lastAcfFieldEl;
    var fieldType = '';

    if (!field && el && window.acf && typeof acf.getField === 'function') {
      try {
        field = acf.getField($(el));
      } catch (e) {
        field = null;
      }
    }

    if (field && typeof field.get === 'function') {
      if (!key) {
        key = field.get('key') || '';
      }
      fieldType = field.get('type') || '';
      if (!el && field.$el && field.$el[0]) {
        el = field.$el[0];
      }
    }

    if (fieldType) {
      parts.push('t:' + fieldType);
    }

    // Prefer the hidden input name — stable across Gutenberg block re-renders.
    if (el) {
      var $el = $(el);
      var inputName =
        $el.find('input[type="hidden"][name^="acf"]').first().attr('name') ||
        $el.find('[name^="acf"]').first().attr('name') ||
        '';
      if (inputName) {
        // Normalize gallery array names: acf[x][y][] → acf[x][y]
        inputName = inputName.replace(/\[\]$/, '');
        parts.push('n:' + inputName);
        if (key) {
          parts.push('k:' + key);
        }
        return parts.join('|');
      }
    }

    var blockId = getSelectedBlockClientId();
    if (blockId) {
      parts.push('b:' + blockId);
    }

    if (key) {
      parts.push('k:' + key);
    }

    if (el) {
      var $row = $(el).closest('.acf-row');
      if ($row.length) {
        parts.push('row:' + ($row.attr('data-id') || String($row.index())));
      }
      var $layout = $(el).closest('.layout');
      if ($layout.length) {
        parts.push('lay:' + ($layout.attr('data-id') || String($layout.index())));
      }
      if (key) {
        var idx = $('.acf-field[data-key="' + key + '"]').index(el);
        if (idx >= 0) {
          parts.push('idx:' + idx);
        }
      }
    }

    // Last resort only — cid is unstable across ACF block re-renders.
    if (parts.length < 3 && field && field.cid) {
      parts.push('cid:' + field.cid);
    }

    return parts.join('|');
  }

  function resolveAcfFieldForPopup(popup) {
    var fieldKey = popup && typeof popup.get === 'function' ? popup.get('field') || '' : '';
    var field = null;

    if (lastAcfFieldEl && window.acf && typeof acf.getField === 'function') {
      try {
        field = acf.getField($(lastAcfFieldEl));
      } catch (e) {
        field = null;
      }
      if (field && fieldKey && typeof field.get === 'function' && field.get('key') !== fieldKey) {
        field = null;
      }
    }

    if (!field && fieldKey && window.acf && typeof acf.getFields === 'function') {
      try {
        var fields = acf.getFields({ key: fieldKey }) || [];
        if (fields.length === 1) {
          field = fields[0];
        } else if (fields.length && lastAcfFieldEl) {
          for (var i = 0; i < fields.length; i++) {
            var candidate = fields[i];
            if (
              candidate &&
              candidate.$el &&
              candidate.$el[0] &&
              (candidate.$el[0] === lastAcfFieldEl ||
                $.contains(candidate.$el[0], lastAcfFieldEl))
            ) {
              field = candidate;
              break;
            }
          }
          if (!field) {
            field = fields[fields.length - 1];
          }
        }
      } catch (e) {
        field = null;
      }
    }

    if (field && field.$el && field.$el[0]) {
      lastAcfFieldEl = field.$el[0];
    }

    return field;
  }

  function getAcfPopup(frame, acfPopup) {
    if (acfPopup && typeof acfPopup.get === 'function') {
      return acfPopup;
    }
    if (frame && frame._mlsAcfPopup && typeof frame._mlsAcfPopup.get === 'function') {
      return frame._mlsAcfPopup;
    }
    // ACF sets frame.acf = MediaPopup in MediaPopup.initialize.
    if (frame && frame.acf && typeof frame.acf.get === 'function') {
      return frame.acf;
    }
    return null;
  }

  /**
   * Attachment id(s) to bring into view when reopening a modal that already
   * has a current value (featured image, image field, gallery).
   */
  function getFocusAttachmentIds(frame) {
    var ids = [];

    function pushId(id) {
      normalizeAttachmentIds([id]).forEach(function (normalized) {
        if (ids.indexOf(normalized) === -1) {
          ids.push(normalized);
        }
      });
    }

    try {
      if (frame && (frame._mlsFeaturedImage || isFeaturedImageFrame(frame))) {
        if (
          wp.media.view &&
          wp.media.view.settings &&
          wp.media.view.settings.post &&
          wp.media.view.settings.post.featuredImageId
        ) {
          pushId(wp.media.view.settings.post.featuredImageId);
        }
        if (wp.data && typeof wp.data.select === 'function') {
          var editor = wp.data.select('core/editor');
          if (editor && typeof editor.getEditedPostAttribute === 'function') {
            pushId(editor.getEditedPostAttribute('featured_media'));
          }
        }
      }
    } catch (e) {
      // Ignore.
    }

    var popup = getAcfPopup(frame, frame && frame._mlsAcfPopup);
    if (popup) {
      var selected = popup.get('selected');
      if (selected && selected.length) {
        pushId(selected[selected.length - 1]);
      }
      pushId(popup.get('attachment'));
    }

    if (lastAcfFieldEl && window.acf && typeof acf.getField === 'function') {
      try {
        var field = acf.getField($(lastAcfFieldEl));
        if (field && typeof field.val === 'function') {
          var val = field.val();
          if (Object.prototype.toString.call(val) === '[object Array]') {
            if (val.length) {
              pushId(val[val.length - 1]);
            }
          } else {
            pushId(val);
          }
        }
      } catch (e) {
        // Ignore.
      }
    }

    try {
      if (frame && typeof frame.state === 'function') {
        var state = frame.state();
        var selection = state && typeof state.get === 'function' ? state.get('selection') : null;
        if (selection && typeof selection.single === 'function') {
          var single = selection.single();
          if (single && single.id) {
            pushId(single.id);
          }
        }
      }
    } catch (e) {
      // Ignore.
    }

    return ids;
  }

  function resolveModalKey(frame, acfPopup) {
    if (frame && frame._mlsInstanceKey) {
      pendingModalKind = null;
      return frame._mlsInstanceKey;
    }

    var popup = getAcfPopup(frame, acfPopup);
    if (popup) {
      if (popup._mlsInstanceKey) {
        pendingModalKind = null;
        return popup._mlsInstanceKey;
      }
      var field = resolveAcfFieldForPopup(popup);
      var fieldKey = popup.get('field') || '';
      pendingModalKind = null;
      return buildAcfInstanceKey(fieldKey, field);
    }

    // Prefer explicit featured-image intent from the click that opened media.
    if (pendingModalKind === 'featured-image' || isFeaturedImageFrame(frame)) {
      pendingModalKind = null;
      return 'featured-image';
    }

    pendingModalKind = null;

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

    // Library items are in the DOM now — retry scroll-to-selected if needed.
    if (pendingFocusAttachmentIds && pendingFocusAttachmentIds.length) {
      var $root = null;
      try {
        if (window.wp && wp.media && wp.media.frame && wp.media.frame.$el) {
          $root = wp.media.frame.$el;
        }
      } catch (e) {
        // Ignore.
      }
      scheduleScrollToAttachment(pendingFocusAttachmentIds, $root);
    }
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
      if (this.args && Object.prototype.hasOwnProperty.call(this.args, queryVar)) {
        delete this.args[queryVar];
      }

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

      // Gutenberg MediaUpload.updateCollection() wipes visible models, forces
      // _hasMore, then more(). If the mirrored query is empty, treat like the
      // initial read so featured-image restore can still inflate.
      if (
        persistModals &&
        activeModalKey &&
        this.args &&
        this.length === 0 &&
        !this._mls
      ) {
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

      var promise = originalMore.apply(this, arguments);
      if (promise && typeof promise.done === 'function') {
        promise.done(function () {
          if (query._mls && query._mls.inflatedPages) {
            var inflatedPages = query._mls.inflatedPages;
            var originalPerPage = query._mls.originalPerPage;
            query._mls.inflatedPages = 0;
            query.args.posts_per_page = originalPerPage;
            if (query.length < originalPerPage * inflatedPages) {
              query._hasMore = false;
            } else {
              query._hasMore = true;
            }
          }
          var pagesAfter = pagesFromLength(query);
          persistAfterLoad(query, pagesAfter);
        });
      }
      return promise;
    };

    proto._mediaLibraryStatePatched = true;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Manage screen: URL filters via PHP queryVars + live URL writes     */
  /* ------------------------------------------------------------------ */

  /**
   * upload.php seeds _wpMediaGridSettings.queryVars from $_GET. Strip our
   * pagination param so it is not treated as an attachment query arg.
   * Also seed order defaults before the Manage frame boots so filter dropdowns
   * match without a post-ready props.set (that requery can prevent
   * Backbone.history from starting, breaking core ?item= navigation).
   */
  function sanitizeGridSettings() {
    if (!window._wpMediaGridSettings || !_wpMediaGridSettings.queryVars) {
      return;
    }
    var vars = _wpMediaGridSettings.queryVars;
    if (Object.prototype.hasOwnProperty.call(vars, queryVar)) {
      delete vars[queryVar];
    }
    if (!vars.order) {
      vars.order = 'DESC';
    }
    if (!vars.orderby) {
      vars.orderby = 'date';
    }
  }

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

  /**
   * Light post-ready cleanup only. Order defaults are seeded in
   * sanitizeGridSettings before the frame is created — do not props.set /
   * trigger('change') here or the library remirrors, AttachmentsBrowser is
   * recreated, and Manage never starts Backbone.history (?item= breaks).
   */
  function syncManageFilterUi(library) {
    if (!library || !library.props) {
      return;
    }

    suppressUrlWrite = true;
    try {
      if (library.props.get(queryVar) != null) {
        library.props.unset(queryVar, { silent: true });
      }
      restoreSearchInput(library.props.get('search'));
    } finally {
      suppressUrlWrite = false;
    }
  }

  function bindManageLibrary(library) {
    if (!library || !library.props) {
      return;
    }

    managedFilterKeys = Object.keys(readUrlFilters());
    syncManageFilterUi(library);
    manageFingerprint = fingerprintProps(library.props);
    snapshotManageLocation();

    if (typeof library.props.off === 'function') {
      library.props.off('change.mediaLibraryState');
    }
    library.props.on('change.mediaLibraryState', onManagePropsChange);
  }

  /**
   * Core closes the item modal via EditAttachments.resetRoute → navigate to
   * upload.php or upload.php?search= only. Restore the snapshotted manage URL.
   */
  function patchEditAttachmentsResetRoute() {
    if (
      !isUploadScreen ||
      !persistUrl ||
      !window.wp ||
      !wp.media ||
      !wp.media.view ||
      !wp.media.view.MediaFrame ||
      !wp.media.view.MediaFrame.EditAttachments
    ) {
      return false;
    }

    var proto = wp.media.view.MediaFrame.EditAttachments.prototype;
    if (proto._mediaLibraryStateResetPatched) {
      return true;
    }

    var originalResetRoute = proto.resetRoute;
    proto.resetRoute = function () {
      if (lastManageFragment) {
        try {
          var router = this.gridRouter;
          if (router && typeof router.navigate === 'function') {
            router.navigate(lastManageFragment, { replace: true, trigger: false });
            return;
          }
          var pathAndSearch = fragmentToPathAndSearch(lastManageFragment);
          if (pathAndSearch && window.history && history.replaceState) {
            history.replaceState(null, '', pathAndSearch);
            return;
          }
        } catch (e) {
          // Fall through to core.
        }
      }
      return originalResetRoute.apply(this, arguments);
    };

    proto._mediaLibraryStateResetPatched = true;
    return true;
  }

  function bindManageGridReady() {
    if (!isUploadScreen || !persistUrl || window._mediaLibraryStateGridBound) {
      return;
    }
    window._mediaLibraryStateGridBound = true;

    snapshotManageLocation();
    patchEditAttachmentsResetRoute();

    $(document).on('wp-media-grid-ready.mediaLibraryState', function (event, frame) {
      patchEditAttachmentsResetRoute();
      var state = frame && typeof frame.state === 'function' ? frame.state() : null;
      var library = state && typeof state.get === 'function' ? state.get('library') : null;
      if (library) {
        bindManageLibrary(library);
      }
      if (readUrlPages() > 1) {
        scheduleScrollToBottom(null);
      }
    });

    // Frame may already exist if media.js ran first.
    if (window.wp && wp.media && wp.media.frames && wp.media.frames.browse) {
      var existing = wp.media.frames.browse;
      var state = typeof existing.state === 'function' ? existing.state() : null;
      var library = state && typeof state.get === 'function' ? state.get('library') : null;
      if (library) {
        bindManageLibrary(library);
      }
    }
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

  function isManageFrame(frame) {
    try {
      return !!(
        frame &&
        window.wp &&
        wp.media &&
        wp.media.view &&
        wp.media.view.MediaFrame &&
        wp.media.view.MediaFrame.Manage &&
        frame instanceof wp.media.view.MediaFrame.Manage
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Prepare modal key / bindings before MediaFrame.open attaches content.
   * Gutenberg featured image uses unstableFeaturedImageFlow, which constructs
   * `new MediaFrame.Select.extend(...)` and never goes through wp.media() —
   * so bindModalFrame from the factory never runs on the real frame. Queries
   * also start during modal.attach(), before the 'open' event, so the key
   * must be set here or inflation never runs.
   */
  function activateModalSession(frame) {
    if (!persistModals || !frame || isManageFrame(frame)) {
      return;
    }

    if (pendingModalKind === 'featured-image' || isFeaturedImageFrame(frame)) {
      frame._mlsFeaturedImage = true;
    }
    if (frame.acf && typeof frame.acf.get === 'function') {
      frame._mlsAcfPopup = frame.acf;
    }

    bindModalFrame(frame, frame._mlsAcfPopup || null);

    activeModalKey = resolveModalKey(frame, frame._mlsAcfPopup || null);
    restoredThisOpen = Object.create(null);
    frame._mlsSessionKey = activeModalKey;

    var focusIds = getFocusAttachmentIds(frame);
    pendingFocusAttachmentIds = focusIds.length ? focusIds : null;

    var saved = modalStates.get(activeModalKey);
    var key = activeModalKey;

    function queueFocusScroll() {
      if (activeModalKey !== key) {
        return;
      }
      // Re-read ids — featured-image selection is often applied in onOpen
      // after activateModalSession runs.
      var latest = getFocusAttachmentIds(frame);
      if (latest.length) {
        pendingFocusAttachmentIds = latest;
      }
      if (pendingFocusAttachmentIds && pendingFocusAttachmentIds.length) {
        scheduleScrollToAttachment(pendingFocusAttachmentIds, frame.$el);
      } else if (saved && typeof saved.scrollTop === 'number' && saved.scrollTop > 0) {
        scheduleScrollRestore(saved.scrollTop, frame.$el);
      }
    }

    window.setTimeout(function () {
      if (activeModalKey !== key) {
        return;
      }
      if (saved && saved.queryProps && Object.keys(saved.queryProps).length) {
        applyModalQueryProps(frame, saved.queryProps);
      }
      queueFocusScroll();
    }, 0);

    // Retry after MediaUpload.onOpen / ACF filters settle and after library paints.
    window.setTimeout(queueFocusScroll, 400);
    window.setTimeout(queueFocusScroll, 1000);

    // When attachments are added to the library (inflated fetch / more), scroll again.
    try {
      var state = typeof frame.state === 'function' ? frame.state() : null;
      var library = state && typeof state.get === 'function' ? state.get('library') : null;
      if (library && typeof library.on === 'function' && !frame._mlsFocusLibraryBound) {
        frame._mlsFocusLibraryBound = true;
        var onLibraryChange = function () {
          if (pendingFocusAttachmentIds && pendingFocusAttachmentIds.length) {
            scheduleScrollToAttachment(pendingFocusAttachmentIds, frame.$el);
          }
        };
        library.on('add reset', onLibraryChange);
        frame.on('close', function () {
          library.off('add reset', onLibraryChange);
          frame._mlsFocusLibraryBound = false;
        });
      }
    } catch (e) {
      // Ignore.
    }
  }

  function patchMediaFrameOpen() {
    if (
      !window.wp ||
      !wp.media ||
      !wp.media.view ||
      !wp.media.view.MediaFrame ||
      wp.media.view.MediaFrame.prototype._mediaLibraryStateOpenPatched
    ) {
      return !!(window.wp && wp.media && wp.media.view && wp.media.view.MediaFrame);
    }

    var proto = wp.media.view.MediaFrame.prototype;
    var originalOpen = proto.open;

    proto.open = function () {
      activateModalSession(this);
      return originalOpen.apply(this, arguments);
    };

    proto._mediaLibraryStateOpenPatched = true;
    return true;
  }

  function bindModalFrame(frame, acfPopup) {
    if (!frame || typeof frame.on !== 'function') {
      return;
    }

    // upload.php Manage grid is not a picker modal — binding it would set
    // activeModalKey permanently and block media_pages / filter URL writes.
    if (isManageFrame(frame)) {
      return;
    }

    // ACF calls wp.media() before new_media_popup — always keep the latest popup.
    if (acfPopup) {
      frame._mlsAcfPopup = acfPopup;
    } else if (frame.acf && typeof frame.acf.get === 'function') {
      frame._mlsAcfPopup = frame.acf;
    }

    if (frame._mediaLibraryStateBound) {
      return;
    }

    frame._mediaLibraryStateBound = true;

    frame.on('open', function () {
      if (!persistModals) {
        return;
      }

      // Re-read ACF popup at open time when session was not pre-activated
      // (e.g. rare paths that skip MediaFrame.open).
      if (frame.acf && typeof frame.acf.get === 'function') {
        frame._mlsAcfPopup = frame.acf;
      }

      // activateModalSession already set the key before attach/query — do not
      // clear restoredThisOpen or we wipe the inflation flag mid-request.
      if (frame._mlsSessionKey && activeModalKey === frame._mlsSessionKey) {
        return;
      }

      activateModalSession(frame);
    });

    frame.on('close', function () {
      if (!persistModals || !activeModalKey) {
        activeModalKey = null;
        pendingModalKind = null;
        pendingFocusAttachmentIds = null;
        if (frame) {
          frame._mlsSessionKey = null;
        }
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
      pendingModalKind = null;
      pendingFocusAttachmentIds = null;
      frame._mlsSessionKey = null;
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
    patchFeaturedImageFrame();
    return true;
  }

  /**
   * Classic #set-post-thumbnail uses wp.media.featuredImage.frame(). Tag it so
   * resolveModalKey does not fall through to block:/select.
   */
  function patchFeaturedImageFrame() {
    if (!window.wp || !wp.media || !wp.media.featuredImage) {
      return false;
    }
    if (wp.media.featuredImage._mediaLibraryStatePatched) {
      return true;
    }

    var originalFrame = wp.media.featuredImage.frame;
    if (typeof originalFrame !== 'function') {
      return false;
    }

    wp.media.featuredImage.frame = function () {
      var frame = originalFrame.apply(this, arguments);
      if (frame) {
        frame._mlsFeaturedImage = true;
        bindModalFrame(frame, null);
      }
      return frame;
    };

    if (wp.media.featuredImage._frame) {
      wp.media.featuredImage._frame._mlsFeaturedImage = true;
      bindModalFrame(wp.media.featuredImage._frame, null);
    }

    wp.media.featuredImage._mediaLibraryStatePatched = true;
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

    var acfFieldSelector =
      '.acf-field[data-type="image"], .acf-field[data-type="gallery"], .acf-field[data-type="file"]';

    function captureAcfFieldEl(el) {
      if (!el) {
        return;
      }
      var fieldEl =
        el.closest && el.closest('.acf-field[data-type="image"], .acf-field[data-type="gallery"], .acf-field[data-type="file"]');
      lastAcfFieldEl = fieldEl || el;
      pendingModalKind = 'acf';
    }

    // Capture the specific field instance before ACF opens its media popup.
    $(document).on(
      'mousedown.mediaLibraryState click.mediaLibraryState',
      acfFieldSelector,
      function () {
        captureAcfFieldEl(this);
      }
    );

    // Gallery's "Add to gallery" control — bind explicitly (pro field events).
    $(document).on(
      'mousedown.mediaLibraryState click.mediaLibraryState',
      '.acf-gallery-add, .acf-field-gallery .acf-button',
      function (event) {
        captureAcfFieldEl(event.target);
      }
    );

    acf.addAction('new_media_popup', function (popup) {
      ensureQueryPatch();
      if (!popup) {
        return;
      }

      var field = resolveAcfFieldForPopup(popup);
      var fieldKey = typeof popup.get === 'function' ? popup.get('field') || '' : '';
      var instanceKey = buildAcfInstanceKey(fieldKey, field);
      popup._mlsInstanceKey = instanceKey;

      if (popup.frame) {
        // Must run after wp.media() bind so we attach the ACF popup reference
        // (bindModalFrame is otherwise a no-op once _mediaLibraryStateBound).
        popup.frame._mlsInstanceKey = instanceKey;
        popup.frame._mlsAcfPopup = popup;
        bindModalFrame(popup.frame, popup);
      }
    });

    return true;
  }

  function bindFeaturedImageOpeners() {
    if (window._mediaLibraryStateFeaturedBound) {
      return;
    }
    window._mediaLibraryStateFeaturedBound = true;

    // Classic meta box + block editor featured image controls.
    $(document).on(
      'mousedown.mediaLibraryState click.mediaLibraryState',
      [
        '#set-post-thumbnail',
        '#postimagediv .inside img',
        '.editor-post-featured-image__toggle',
        '.editor-post-featured-image__preview',
        '.editor-post-featured-image__container button',
        '.editor-post-featured-image button',
        '.editor-post-featured-image__media-modal',
      ].join(', '),
      function () {
        pendingModalKind = 'featured-image';
      }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  function boot() {
    managedFilterKeys = Object.keys(readUrlFilters());
    sanitizeGridSettings();
    ensureQueryPatch();
    bindManageGridReady();
    patchEditAttachmentsResetRoute();
    patchMediaFactory();
    patchFeaturedImageFrame();
    patchMediaFrameOpen();
    bindAcfPopups();
    bindFeaturedImageOpeners();
    snapshotManageLocation();

    // Reload with media_pages already set — scroll once attachments inflate.
    if (isUploadScreen && readUrlPages() > 1) {
      scheduleScrollToBottom(null);
    }
  }

  sanitizeGridSettings();

  if (!ensureQueryPatch()) {
    $(boot);
  } else {
    bindManageGridReady();
    patchMediaFactory();
    patchFeaturedImageFrame();
    patchMediaFrameOpen();
    bindAcfPopups();
    bindFeaturedImageOpeners();
  }

  $(function () {
    boot();
  });
})(window, jQuery);
