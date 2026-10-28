const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../resources/js/media-library-state.js'), 'utf8');

function createGrid({ infinite, search = '' }) {
  const timers = [];
  const scrolls = [];
  const location = new URL(`https://example.test/wp-admin/upload.php${search}`);
  const document = {
    documentElement: { scrollHeight: 3000 },
    body: { scrollHeight: 3000 },
  };
  const empty = {
    length: 0,
    on() { return this; },
    find() { return this; },
    first() { return this; },
  };
  function $(value) {
    if (typeof value === 'function') {
      value();
      return empty;
    }
    return empty;
  }
  $.extend = Object.assign;

  function Query() {
    this.length = 80;
    this.args = { posts_per_page: 80 };
    this.props = { toJSON: () => ({}) };
  }
  Query.prototype.sync = function () {};
  Query.prototype.more = function () {
    this.length += 80;
    return { done(callback) { callback(); return this; } };
  };

  function media() {}
  media.model = { Query };
  media.view = { settings: { infiniteScrolling: infinite ? 1 : 0 } };
  const wp = { media };
  const history = {
    replaceState(_state, _title, value) {
      const next = new URL(value, location);
      location.href = next.href;
    },
  };
  const window = {
    mediaLibraryState: { isUploadScreen: true },
    wp,
    location,
    history,
    innerHeight: 800,
    setTimeout(callback) { timers.push(callback); },
    scrollTo(...args) { scrolls.push(args); },
  };
  const context = { window, document, wp, history, jQuery: $, URL, URLSearchParams };
  vm.runInNewContext(script, context, { filename: 'media-library-state.js' });

  return {
    Query,
    location,
    scrolls,
    flushTimers() {
      while (timers.length) timers.shift()();
    },
  };
}

test('infinite scrolling persists loaded pages without moving the viewport', () => {
  const grid = createGrid({ infinite: true });
  new grid.Query().more();
  grid.flushTimers();
  assert.equal(grid.location.searchParams.get('media_pages'), '2');
  assert.equal(grid.scrolls.length, 0);
});

test('restoring a saved depth does not start an infinite-scroll loop', () => {
  const grid = createGrid({ infinite: true, search: '?media_pages=3' });
  grid.flushTimers();
  assert.equal(grid.location.searchParams.get('media_pages'), '3');
  assert.equal(grid.scrolls.length, 0);
});

test('button-based loading retains its bottom-of-grid behavior', () => {
  const grid = createGrid({ infinite: false });
  new grid.Query().more();
  grid.flushTimers();
  assert.equal(grid.location.searchParams.get('media_pages'), '2');
  assert.deepEqual(grid.scrolls, [[0, 3000]]);
});
