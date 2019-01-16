// ==UserScript==
// @name         Kitsu MALonnaised
// @description  Shows MyAnimeList.net data on Kitsu.io
// @version      1.0.0

// @namespace    https://github.com/tophf
// @author       tophf
// @inspired-by  https://greasyfork.org/scripts/5890

// @match        *://kitsu.io/*

// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        unsafeWindow

// @require      https://greasyfork.org/scripts/27531/code/LZStringUnsafe.js
// @run-at       document-start

// @connect      myanimelist.net
// @connect      kitsu.io
// ==/UserScript==

'use strict';
/* global GM_info GM_xmlhttpRequest GM_addStyle GM_getValue GM_setValue GM_openInTab */
/* global unsafeWindow exportFunction */
/* global LZStringUnsafe */

const API_URL = 'https://kitsu.io/api/edge/';
const MAL_URL = 'https://myanimelist.net/';
const MAL_CDN_URL = 'https://cdn.myanimelist.net/';
let MAL_IMG_EXT = '.jpg';
// maximum number present in a MAL page initially
const MAL_RECS_LIMIT = 24;
const MAL_CHARS_LIMIT = 10;
const KITSU_GRAY_LINK_CLASS = 'import-title';
const LAZY_ATTR = 'malsrc';
const $LAZY_ATTR = '$' + LAZY_ATTR;

const DB_NAME = 'MALonnaise';
const DB_STORE_NAME = 'data';

const HOUR = 3600e3;
const CACHE_DURATION = 24 * HOUR;

const ID = (name => Object.defineProperties({
  SCORE: `${name}:SCORE`,
  USERS: `${name}:USERS`,
  FAVS: `${name}:FAVS`,
  CHARS: `${name}:CHARS`,
  RECS: `${name}:RECS`,
}, {
  me: {
    value: name.replace(/\W/g, ''),
  },
  selectorPrefix: {
    value: CSS.escape(name + ':'),
  },
  selectAll: {
    value(suffix = '') {
      return Object.keys(ID)
        .map(id => `#${ID.selectorPrefix}${id} ${suffix}`)
        .join(',');
    },
  },
}))(GM_info.script.name);

const API = (() => {
  const API_OPTIONS = {
    headers: {
      'Accept': 'application/vnd.api+json',
    },
  };
  const PATH = Symbol('path');
  const handler = {
    get(target, endpoint) {
      let path = target[PATH];
      path += (path ? '/' : '') + endpoint;
      const fn = Object.defineProperty(() => {}, PATH, {value: path});
      return new Proxy(fn, handler);
    },
    apply(target, thisArg, [options]) {
      for (const [k, v] of Object.entries(options)) {
        if (typeof v === 'object') {
          delete options[k];
          for (const [kk, vv] of Object.entries(v))
            options[`${k}[${kk}]`] = vv;
        }
      }
      const url = `${API_URL}${target[PATH]}?${new URLSearchParams(options)}`;
      return fetch(url, API_OPTIONS).then(r => r.json());
    },
  };
  return new Proxy({[PATH]: ''}, handler);
})();


/**
 * @property {Object} data
 * @property {String} renderedPath
 */
class App {

  static async init() {
    App.data = {};
    new InterceptXHR().subscribe(v => App.processMappings(v).then(App.plant));
    new InterceptHistory().subscribe(App.onUrlChange);
    window.addEventListener('popstate', () => App.onUrlChange());

    await Cache.init();
    App.onUrlChange();
    App.initStyles();

    // detect WebP support
    $create('img', {
      src: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
      onload() {
        MAL_IMG_EXT = '.webp';
      },
    });
  }

  static async onUrlChange(path = location.pathname) {
    const [, type, slug] = path.match(/\/(anime|manga)\/([^/?#]+)(?:[?#].*)?$|$/);
    App.hide();
    if (!slug)
      App.data = {path};
    if (App.data.path === path)
      return;
    let data = await Cache.read(type, slug) || {};
    App.data = data;
    if (!data.path) {
      API[type]({
        filter: {slug},
        include: 'mappings',
        fields: {
          mappings: 'externalSite,externalId',
          anime: 'id,slug',
        },
      }).then(App.processMappings)
        .then(App.plant);
      return;
    }
    if (data.expired) {
      App.plant(data);
      App.renderedPath = '';
    }
    if (data.expired || !data.score) {
      data = await App.processMal({type, slug, TID: data.TID});
      App.data = data;
    }
    App.plant(data);
  }

  static async processMappings(payload) {
    const url = Mal.findUrl(payload);
    if (!url)
      return;
    const {type, attributes: {slug}} = payload.data[0];
    const data = await Cache.read(type, slug);
    return data && !data.expired && data.score ?
      data :
      App.processMal({type, slug, url});
  }

  static async processMal({type, slug, url, TID}) {
    App.busy = true;
    App.hide();
    const data = await Mal.scavenge(url || MalTypeId.toUrl(TID));
    data.TID = TID || MalTypeId.urlToTID(url);
    Cache.write(type, slug, data);
    return data;
  }

  static async plant(data) {
    if (!data || data.path === App.renderedPath)
      return;

    const [type, slug] = data.path.split('/');
    const url = MalTypeId.toUrl(data.TID);
    Object.assign(data, {type, slug, url});

    await Mutant.gotSlugged(data);

    Render.all(data);

    App.renderedPath = data.path;
    App.busy = false;
  }

  static async hide() {
    App.renderedPath = '';
    await Util.nextTick();
    if (!App.busy)
      return;
    for (const el of $$(ID.selectAll()))
      el.style.opacity = 0;
  }

  static initStyles() {
    Mutant.gotTheme().then(() => {
      const bgColor = getComputedStyle(document.body).backgroundColor;
      document.head.append(
        $create('style', `
          #${CSS.escape(ID.RECS)} {
            --${ID.me}-bg-color: ${bgColor};
          }`));
    });

    const MAIN_TRANSITION = 'opacity .25s';

    const RECS_MIN_HEIGHT = 250;
    const RECS_MAX_HEIGHT = RECS_MIN_HEIGHT * 10;
    const RECS_IMG_MARGIN = '.5rem';
    const RECS_TRANSITION_TIMING = '.5s .25s';

    const EXT_LINK = `url('data:image/svg+xml;utf8,
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22">
        <path d="M13,0v2h5.6L6.3,14.3l1.4,1.4L20,3.4V9h2V0H13z M0,4v18h18V9l-2,2v9H2V6h9l2-2H0z"/>
      </svg>')`.replace(/\s+</g, '<');
    const EXT_LINK_SIZE_EM = 1;

    let maskImageProp = 'mask-image';
    const extLinkRule =
      !CSS.supports(maskImageProp, EXT_LINK) &&
      !CSS.supports((maskImageProp = '-webkit-' + maskImageProp), EXT_LINK) ?
        '' :
        // language=CSS
        `
        a[mal]::after {
          content: "\\a0";
          ${maskImageProp}: ${EXT_LINK};
          background-color: currentColor;
          margin-left: ${EXT_LINK_SIZE_EM / 2}em;
          width: ${EXT_LINK_SIZE_EM}em;
          height: ${EXT_LINK_SIZE_EM}em;
          display: inline-block;
          opacity: .5;
        }
        #RECS a[mal="recs-all"]::after,
        a[mal="rec"]::after {
          vertical-align: text-top;
        }
        a[mal]:hover::after {
          opacity: 1;
        }
        `;

    // language=CSS
    GM_addStyle(`
      ${extLinkRule}
      .media--sidebar .is-sticky {
        position: static !important;
      }
      #SCORE:hover,
      ${ID.selectAll('a:hover')} {
        text-decoration: underline;
      }
      ${ID.selectAll()} {
        transition: ${MAIN_TRANSITION};
      }
      #SCORE:not(:first-child),
      #USERS,
      #FAVS {
        margin-left: 1em;
      }
      #USERS::before {
        content: '\\1F464';
        margin-right: .25em;
      }
      #FAVS::before {
        content: '\\2764';
        margin-right: .25em;
      }
      /*******************************************************/
      #CHARS h5 {
        display: inline-block;
      }
      #CHARS h5 a {
        font: inherit;
      }
      #CHARS summary {
        cursor: zoom-in;
      }
      #CHARS details[open] summary {
        cursor: zoom-out;
      }
      #CHARS summary:hover {
        color: #fff;
      }
      #CHARS[mal="anime"] div[mal] {
        width: 50%;
        display: inline-block;
      }
      #CHARS[mal="manga"] li {
        width: calc(50% - 4px);
        display: inline-block;
      }
      #CHARS[mal="manga"] li:nth-child(odd) {
        margin-right: 8px;
      }
      #CHARS div[mal="people"] {
        opacity: .5;
        will-change: opacity;
        transition: opacity .25s .1s;
      }
      #CHARS div[mal="people"] img {
        opacity: .3;
        will-change: opacity;
        transition: opacity .25s .1s;
      }
      #CHARS div[mal="people"]:only-child {
        width: 100%;
        opacity: 1;
      }
      #CHARS div[mal="people"]:only-child img {
        opacity: .15;
      }
      #CHARS:hover div[mal="people"] img {
        opacity: .6;
      }
      #CHARS div[mal="people"]:hover,
      #CHARS div[mal="people"] img:hover {
        opacity: 1;
      }
      #CHARS div[mal]:first-child a {
        font-weight: bold;
      }
      #CHARS span {
        display: inline-block;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: calc(100% - 2 * ${EXT_LINK_SIZE_EM}em); /* room for the ext link icon */
        vertical-align: sub;
      }
      #CHARS a div {
        overflow: hidden;
        width: 100%;
      }
      #CHARS div[mal="people"]:only-child {
        width: 100%;
      }
      #CHARS img {
        width: calc(100% + 2px);
        max-width: none;
        margin: -1px;
      }
      #CHARS img[malsrc] {
        padding: 0 100% ${Util.num2pct(350 / 225)} 0;
      }
      #CHARS div[mal]:not(:only-child) a > :first-child:not(div) {
        margin-top: 60%;
      }
      #CHARS small {
        display: block;
        margin: -.5em 0 8px 0;
      }
      /* replace the site's chars */
      #CHARS {
        max-height: calc(200px + 4.5em);
        overflow: hidden;
      }
      #CHARS[hovered] {
        max-height: none;
      }
      #CHARS:not([hovered]) ul {
        display: flex;
        flex-wrap: wrap;
      }
      #CHARS:not([hovered]) li {
        width: calc(25% - 6px);
        margin: 0 3px 6px;
        position: relative;
      }
      #CHARS:not([hovered]) div[mal] {
        width: 100%;
      }
      #CHARS:not([hovered]) a div {
        border-radius: 3px;
      }
      #CHARS[mal="anime"]:not([hovered]) div[mal="people"],
      #CHARS:not([hovered]) small,
      #CHARS:not([hovered]) li a[mal]::after {
        display:none;
      }
      #CHARS:not([hovered]) span {
        max-width: 100%;
      }
      /*******************************************************/
      #RECS {
        margin-bottom: 1em;
        max-height: ${RECS_MIN_HEIGHT}px;
        overflow: hidden;
        position: relative;
        contain: layout;
        transition: ${MAIN_TRANSITION}, max-height ${RECS_TRANSITION_TIMING};
      }
      #RECS:hover {
        max-height: ${RECS_MAX_HEIGHT}px;
      }
      #RECS::before {
        background: linear-gradient(transparent 33%, var(--${ID.me}-bg-color));
        position: absolute;
        display: block;
        content: "";
        width: 100%;
        min-height: 100%;
        pointer-events: none;
        z-index: 999;
        transition: min-height ${RECS_TRANSITION_TIMING},
                    opacity ${RECS_TRANSITION_TIMING};
      }
      #RECS:hover::before {
        opacity: 0;
        min-height: ${RECS_MAX_HEIGHT}px;
      }
      #RECS ul {
        display: flex;
        flex-wrap: wrap;
        margin: 0 -${RECS_IMG_MARGIN} 0 0;
        padding: 0;
      }
      #RECS li {
        list-style: none;
        position: relative;
        margin: 0 .5rem .5rem 0;
        width: calc(${Util.num2pct(1 / 4)} - ${RECS_IMG_MARGIN});
        line-height: 1;
        display: flex;
        flex-direction: column;
      }
      #RECS li[mal="auto-rec"] {
        opacity: .25;
      }
      #RECS li[mal="auto-rec"]:hover {
        opacity: 1;
      }
      #RECS a[mal="title"] {
        margin: 0 0 ${Util.num2pct(315 / 225)};
        font-size: .8rem;
        font-weight: bolder;
      }
      #RECS div {
        overflow: hidden;
        position: absolute;
        top: 2rem;
        left: 0;
        right: 0;
        bottom: 0;
        background-size: calc(100% + 2px);
        background-position: -1px -1px;
        background-repeat: no-repeat;
        transition: opacity .5s, filter .5s;
        cursor: pointer;
      }
      #RECS li[mal="auto-rec"] div {
        filter: grayscale(1);
      }
      #RECS li[mal="auto-rec"]:hover div {
        filter: none;
      }
      #RECS a[mal="title"] div::after {
        content: "MAL only";
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        box-sizing: content-box;
        width: 2rem;
        height: 2rem;
        margin: auto;
        padding: .75rem .6rem .5rem;
        text-align: center;
        line-height: .9;
        font-weight: bold;
        font-size: 1rem;
        letter-spacing: -.05em;
        border: 3px solid #fff;
        border-radius: 4rem;
        background: #2E51A2;
        color: #fff;
        box-shadow: 2px 3px 10px 2px #000a;
        transition: opacity .5s .1s;
        opacity: 0;
      }
      #RECS a[mal="title"] div:hover::after {
        opacity: 1;
      }
      #RECS span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding: 0;
        margin: 0;
        display: inline-block;
        vertical-align: sub;
        max-width: calc(100% - 1.5 * ${EXT_LINK_SIZE_EM}em);
      }
      #RECS small {
        font-size: .75rem;
        opacity: .75;
        margin-bottom: .25em;
      }
    `
      // language=JS
    .replace(
      new RegExp(`#(?=${Object.keys(ID).join('|')})\\b`, 'g'),
      '#' + ID.selectorPrefix
    ));
  }
}


/**
 * @property {IDB} db
 */
class Cache {

  static async init() {
    Cache.idb = new IDB(DB_NAME, DB_STORE_NAME);
    await Cache.idb.open({
      onupgradeneeded(e) {
        if (!e.oldVersion) {
          const store = e.target.result.createObjectStore(DB_STORE_NAME, {keyPath: 'path'});
          store.createIndex('TID', 'TID', {unique: true});
          store.createIndex('time', 'time', {unique: false});
        }
      },
    });
  }

  static async read(type, slug) {
    const path = type + '/' + slug;
    const data = await Cache.idb.get(path);
    if (!data)
      return;
    data.path = path;
    if (Date.now() - data.time > CACHE_DURATION) {
      data.expired = true;
    } else if (data.lz) {
      for (const [k, v] of Object.entries(data.lz))
        data[k] = Util.parseJson(LZStringUnsafe.decompressFromUTF16(v));
      data.lz = undefined;
    }
    return data;
  }

  static async write(type, slug, data) {
    data.path = type + '/' + slug;
    data.time = Date.now();
    const toWrite = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined)
        continue;
      if (v && typeof v === 'object') {
        const str = JSON.stringify(v);
        if (str.length > 100) {
          toWrite.lz = toWrite.lz || {};
          toWrite.lz[k] = LZStringUnsafe.compressToUTF16(str);
          continue;
        }
      }
      toWrite[k] = v;
    }
    try {
      await Cache.idb.put(toWrite);
    } catch (e) {
      if (e instanceof DOMException &&
          e.code === DOMException.QUOTA_EXCEEDED_ERR)
        Cache.cleanup();
    }
  }

  static cleanup() {
    this.idb.exec({index: 'time', write: true, raw: true})
      .openCursor(IDBKeyRange.upperBound(Date.now - CACHE_DURATION))
      .onsuccess = e => {
        const cursor = /** @type IDBCursorWithValue */ e.target.result;
        if (!cursor)
          return;
        const {value} = cursor;
        if (value.lz) {
          delete value.lz;
          cursor.update(value);
        }
        cursor.continue();
      };
  }
}


class Get {
  static doc(url) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        url,
        method: 'GET',
        onload(r) {
          const doc = new DOMParser().parseFromString(r.response, 'text/html');
          resolve(doc);
        },
      });
    });
  }
}


/**
 * @property {IDBDatabase} db
 */
class IDB {

  constructor(name, storeName) {
    this.name = name;
    this.storeName = storeName;
  }

  open(events) {
    return new Promise(resolve => {
      Object.assign(indexedDB.open(this.name), events, {
        onsuccess: e => {
          this.db = e.target.result;
          resolve();
        },
      });
    });
  }

  get(key, index) {
    return this.exec({index}).get(key);
  }

  put(value) {
    return this.exec({write: true}).put(value);
  }

  /**
   * @param _
   * @param {Boolean} [_.write]
   * @param {String} [_.index]
   * @param {Boolean} [_.raw]
   * @return {Promise<IDBObjectStore|IDBIndex>|IDBObjectStore|IDBIndex}
   */
  exec({write, index, raw} = {}) {
    return new Proxy({}, {
      get: (_, method) =>
        (...args) => {
          let op = this.db
            .transaction(this.storeName, write ? 'readwrite' : 'readonly')
            .objectStore(this.storeName);
          if (index)
            op = op.index(index);
          op = op[method](...args);
          return raw ?
            op :
            new Promise((resolve, reject) => {
              op.onsuccess = e => resolve(e.target.result);
              op.onerror = reject;
            });
        },
    });
  }
}


class Intercept {
  constructor() {
    this.subscribers = new Set();
  }

  subscribe(fn) {
    this.subscribers.add(fn);
  }

  notify() {
    for (const fn of this.subscribers)
      fn.apply(null, arguments);
  }
}


class InterceptHistory extends Intercept {
  constructor() {
    super();
    const self = this;
    const pushState = unsafeWindow.History.prototype.pushState;
    unsafeWindow.History.prototype.pushState = function (state, title, url) {
      pushState.apply(this, arguments);
      self.notify(url);
    };
  }
}


class InterceptXHR extends Intercept {
  constructor() {
    super();
    const self = this;
    const XHR = unsafeWindow.XMLHttpRequest;

    unsafeWindow.XMLHttpRequest = class extends XHR {
      open(method, url, ...args) {
        if (url.startsWith(API_URL)) {
          url = InterceptXHR.onOpen.call(this, url) || url;
          if (url !== ID.me) {
            this.addEventListener('load', onLoad, {once: true});
            return super.open(method, url, ...args);
          }
        }
      }
    };

    function onLoad(e) {
      self.notify(JSON.parse(e.target.responseText));
    }
  }

  static onOpen(url) {
    // https://kitsu.io/api/edge/anime?........&include=categories.......
    if (!App.data.TID &&
        url.includes('&include=') && (
          url.includes('/anime?') ||
          url.includes('/manga?'))) {
      const u = new URL(url);
      u.searchParams.set('include', u.searchParams.get('include') + ',mappings');
      u.searchParams.set('fields[mappings]', 'externalSite,externalId');
      return u.href;
    }
    // https://kitsu.io/api/edge/castings?.....&page%5Blimit%5D=4&......
    if (App.data.chars &&
        url.includes('/castings?') &&
        url.includes('page%5Blimit%5D=4')) {
      this.send = InterceptXHR.sendDummy;
      this.setRequestHeader = InterceptXHR.dummy;
      return ID.me;
    }
  }

  static sendDummy() {
    Object.defineProperty(this, 'responseText', {value: '{"data": []}'});
    this.onload({type: 'load', target: this});
  }

  static dummy() {
    // NOP
  }
}


class Mal {

  static findUrl(data) {
    for (const {type, attributes: a} of data.included || []) {
      if (type === 'mappings' &&
          a.externalSite.startsWith('myanimelist')) {
        const malType = a.externalSite.split('/')[1];
        const malId = a.externalId;
        return MAL_URL + malType + '/' + malId;
      }
    }
  }

  static swapNames(str) {
    return str.replace(/(.*), (.*)/, '$2 $1');
  }

  static wring(img, stripId) {
    const text = Util.decodeHtml(img.alt) || 0;
    // https://myanimelist.net/character/101457/Chika_Kudou
    // https://myanimelist.net/recommendations/anime/31859-35790
    // https://myanimelist.net/anime/19815/No_Game_No_Life?suggestion
    const a = img.closest('a');
    let aId = a && a.href.match(/\/(\d+(?:-\d+)?)|$/)[1] || 0;
    if (stripId && aId && aId.includes('-'))
      aId = aId.replace(stripId, '');
    // https://cdn.myanimelist.net/r/23x32/images/characters/7/331067.webp?s=xxxxxxxxxx
    // https://cdn.myanimelist.net/r/23x32/images/voiceactors/1/47102.jpg?s=xxxxxxxxx
    // https://cdn.myanimelist.net/r/90x140/images/anime/13/77976.webp?s=xxxxxxx
    const {src} = img.dataset;
    const imgId = src && src.match(/\/(\d+\/\d+)\.|$/)[1] || 0;
    return [text, aId >> 0, imgId];
  }

  static async scavenge(url) {
    const doc = await Get.doc(url);
    let el, score, users, favs;

    el = $('[itemprop="ratingValue"],' +
           '[data-id="info1"] > span:not(.dark_text)', doc);
    score = $text(el).trim();
    score = score && Number(score.match(/[\d.]+|$/)[0]) || score;
    const ratingCount = Util.str2num($text('[itemprop="ratingCount"]', doc));

    while (el.parentElement && !el.parentElement.textContent.includes('Members:'))
      el = el.parentElement;
    while ((!users || !favs) && (el = el.nextElementSibling)) {
      const txt = el.textContent;
      users = users || Util.str2num(txt.match(/Members:\s*([\d,]+)|$/)[1]);
      favs = favs || Util.str2num(txt.match(/Favorites:\s*([\d,]+)|$/)[1]);
    }

    const chars = $$('.detail-characters-list table[width]', doc)
      .map(el => {
        const char = $('a[href*="/character/"] img', el);
        const actor = $('a[href*="/people/"] img', el);
        return [
          $text('small', el),
          char ? Mal.wring(char) : [],
          ...(actor ? [Mal.wring(actor)] : []),
        ];
      });

    const rxStripOwnId = new RegExp('-?\\b' + url.match(/\d+/)[0] + '\\b-?');
    const recs = $$('#anime_recommendation .link,' +
                    '#manga_recommendation .link', doc)
      .map(a => [
        ...Mal.wring($('img', a), rxStripOwnId),
        parseInt($text('.users', a)) || 0,
      ]);

    return {
      users,
      favs,
      score: score ? [score, ratingCount || 0] : undefined,
      chars: chars.length ? chars : undefined,
      recs: recs.length ? recs : undefined,
    };
  }
}


class MalTypeId {

  static fromUrl(url) {
    return url.match(/((?:anime|manga)\/\d+)|$/)[1] || '';
  }

  static toUrl(typeId) {
    if (!typeId.includes('/'))
      typeId = MalTypeId.fromTID(typeId).join('/');
    return MAL_URL + typeId;
  }

  static fromTID(short) {
    const t = short.slice(0, 1);
    const fullType = t === 'a' && 'anime' ||
                     t === 'm' && 'manga' ||
                     '';
    return [fullType, short.slice(1)];
  }

  static toTID(typeId) {
    return typeId.slice(0, 1) + typeId.split('/')[1];
  }

  static urlToTID(url) {
    return MalTypeId.toTID(MalTypeId.fromUrl(url));
  }
}


class Mutant {

  static gotSlugged(data) {
    const url = location.origin + '/' + data.path;
    const el = $('meta[property="og:url"]');
    if (el && el.content === url)
      return Promise.resolve();
    if (!Mutant._state)
      Mutant.init();
    Mutant._state.url = url;
    return new Promise(Mutant.subscribe);
  }

  static async gotTheme() {
    const selector = 'link[data-theme]';
    const head =
      document.head ||
      new Promise(resolve => {
        new MutationObserver((_, ob) => {
          const head = document.head;
          if (head) {
            ob.disconnect();
            resolve(head);
          }
        }).observe(document.documentElement, {childList: true});
      });
    const el =
      head.querySelector(selector) ||
      await new Promise(resolve => {
        new MutationObserver((mutations, ob) => {
          const el = head.querySelector(selector);
          if (el) {
            ob.disconnect();
            resolve(el);
          }
        }).observe(document.head, {childList: true});
      });
    try {
      el.sheet.cssRules; // eslint-disable-line no-unused-expressions
    } catch (e) {
      await new Promise(done => el.addEventListener('load', done, {once: true}));
    }
  }

  static subscribe(fn) {
    Mutant._state.subscribers.add(fn);
    if (!Mutant._state.active)
      Mutant.start();
  }

  static init() {
    Mutant._state = {
      active: false,
      subscribers: new Set(),
      observer: new MutationObserver(Mutant.observer),
      url: '',
    };
  }

  static start() {
    Mutant._state.observer.observe(document.head, {childList: true});
    Mutant._state.observer.active = true;
  }

  static resolve() {
    Mutant._state.observer.disconnect();
    Mutant._state.observer.active = false;
    Mutant._state.subscribers.forEach(fn => fn.apply(null, arguments));
    Mutant._state.subscribers.clear();
  }

  static observer(mm) {
    for (var i = 0, m; (m = mm[i++]);) {
      for (var j = 0, added = m.addedNodes, n; (n = added[j++]);) {
        if (n.localName === 'meta' &&
            n.content === Mutant._state.url) {
          Mutant.resolve();
          return;
        }
      }
    }
  }
}


class Render {

  static all(data) {
    if (!Render.scrollObserver) {
      Render.scrollObserver = new IntersectionObserver(Render._loadImage, {
        rootMargin: '200px',
      });
    }

    Render.stats(data);
    Render.characters(data);
    Render.recommendations(data);

    for (const el of $$(ID.selectAll(`[${LAZY_ATTR}]`)))
      Render.scrollObserver.observe(el);
  }

  static stats({score: [r, count] = ['N/A'], users, favs, url} = {}) {
    const quarter = r > 0 && Math.max(1, Math.min(4, 1 + (r - .001) / 2.5 >> 0));
    $createLink({
      $mal: '',
      id: ID.SCORE,
      parent: $('.media-rating'),
      href: url,
      title: count && `Scored by ${Util.num2str(count)} users` || '',
      textContent: (r > 0 ? Util.num2pct(r / 10) : r) + ' on MAL',
      className: 'media-community-rating' + (quarter ? ' percent-quarter-' + quarter : ''),
      $style: '',
    });
    $create('span', {
      id: ID.USERS,
      after: $id(ID.SCORE),
      textContent: Util.num2str(users),
      $style: users ? '' : 'opacity:0',
    });
    $create('span', {
      id: ID.FAVS,
      after: $id(ID.USERS),
      textContent: Util.num2str(favs),
      $style: favs ? '' : 'opacity:0',
    });
  }

  static characters({chars, url, type, slug}) {
    const siteChars = $('.media--main-characters');
    if (siteChars)
      siteChars.remove();
    $create('section', {
      $mal: type,
      id: ID.CHARS,
      after: $('.media--information'),
      className: 'media--related',
      $style: chars ? '' : 'opacity:0',
      onmouseover: Render._charsHovered,
      onmouseout: Render._charsHovered,
    }, chars && [
      $create('h5', [
        Util.num2strPlus('%n character%s on MAL: ',
          MAL_CHARS_LIMIT,
          chars.filter(([, [char]]) => char).length),
        $createLink({
          $mal: 'chars-all',
          href: `${url}/${slug}/characters`,
          textContent: 'see all',
        }),
      ]),
      $create('ul', chars.map(Render.char)),
    ]);
  }

  static char([type, [char, charId, charImg], [va, vaId, vaImg] = []]) {
    const el = $create('li');
    if (char) {
      $create('div', {
        $mal: 'char',
        parent: el,
      }, [
        $createLink({
          $mal: 'char',
          href: `${MAL_URL}character/${charId}`,
        }, [
          charImg &&
          $create('div',
            $create('img', {
              [$LAZY_ATTR]: `${MAL_CDN_URL}images/characters/${charImg}${MAL_IMG_EXT}`,
            })),
          $create('span', Mal.swapNames(char)),
        ]),
        $create('small', type),
      ]);
    }
    if (va) {
      $create('div', {
        $mal: 'people',
        parent: el,
      }, [
        $createLink({
          $mal: 'people',
          href: `${MAL_URL}people/${vaId}`,
        }, [
          vaImg &&
          $create('div',
            $create('img', {
              [$LAZY_ATTR]: `${MAL_CDN_URL}images/voiceactors/${vaImg}.jpg`,
            })),
          $create('span', Mal.swapNames(va)),
        ]),
        !char &&
        $create('small', type),
      ]);
    }
    return el;
  }

  static recommendations({recs, url, slug}) {
    $create('section', {
      id: ID.RECS,
      before: $('.media--reactions'),
      $style: recs ? '' : 'opacity:0',
    }, recs && [
      $create('h5', [
        Util.num2strPlus('%n title%s recommended on MAL: ', MAL_RECS_LIMIT, recs.length),
        $createLink({
          $mal: 'recs-all',
          href: `${url}/${slug}/userrecs`,
          className: KITSU_GRAY_LINK_CLASS,
          textContent: 'see all',
        }),
      ]),
      $create('ul', recs.map(Render.rec, arguments[0])),
    ]);
  }

  static rec([name, id, img, count]) {
    const {type, TID} = this;
    return (
      $create('li', {
        onmouseover: Render.kitsuLink,
        $mal: count ? '' : 'auto-rec',
      }, [
        $create('small',
          !count ?
            'auto-rec' :
            $createLink({
              $mal: 'rec',
              href: `${MAL_URL}recommendations/${type}/${id}-${TID.slice(1)}`,
              textContent: `${count} rec${count > 1 ? 's' : ''}`,
              className: KITSU_GRAY_LINK_CLASS,
            })),
        $createLink({
          $mal: 'title',
          href: `${MAL_URL}${type}/${id}`,
          className: KITSU_GRAY_LINK_CLASS,
          children: $create('span', name),
        }),
        $create('div', {
          [$LAZY_ATTR]: `${MAL_CDN_URL}images/${type}/${img}${MAL_IMG_EXT}`,
          onclick: Render._kitsuLinkPreclicked,
          onauxclick: Render._kitsuLinkPreclicked,
        }),
      ])
    );
  }

  static async kitsuLink() {
    this.onmouseover = null;

    const image = $('div', this);
    const malLink = $('a[mal="title"]', this);
    const typeId = MalTypeId.fromUrl(malLink.href);
    const TID = MalTypeId.toTID(typeId);
    const [type, id] = typeId.split('/');

    const {path = ''} = await Cache.idb.get(TID, 'TID') || {};
    let slug = path.split('/')[1];

    if (!slug) {
      const mappings = await API.mappings({
        filter: {
          externalId: id,
          externalSite: 'myanimelist/' + type,
        },
      });
      const entry = mappings.data[0];
      if (entry) {
        const mappingId = entry.id;
        const mapping = await API.mappings[mappingId].item({
          fields: {
            [type]: 'slug',
          },
        });
        slug = mapping.data.attributes.slug;
        Cache.write(type, slug, {TID});
      }
    }

    if (slug) {
      $create('a', {
        href: `/${type}/${slug}`,
        className: KITSU_GRAY_LINK_CLASS,
        children: image,
        parent: this,
      });
    } else {
      malLink.appendChild(image);
    }

    image.onmousedown = null;
  }

  static _charsHovered() {
    if (this[ID.me])
      return;
    this[ID.me] = setTimeout(() => {
      delete this[ID.me];
      if (this.matches(':hover'))
        this.setAttribute('hovered', '');
      else
        this.removeAttribute('hovered');
    }, 250);
  }

  static async _kitsuLinkPreclicked(e) {
    this.onmousedown = null;
    if (e.altKey || e.metaKey || e.button > 1)
      return;
    const t0 = performance.now();
    while (!this.parentNode.href) {
      await Util.nextTick();
      if (performance.now() - t0 > 1000)
        return;
    }
    const {button: btn, ctrlKey: c, shiftKey: s} = e;
    const link = this.parentNode;
    if (!btn && !c) {
      link.dispatchEvent(new MouseEvent('click', e));
      if (!s)
        App.onUrlChange(link.pathname);
    } else {
      GM_openInTab(link.href, {
        active: btn === 0 && c && s,
        insert: true,
        setParent: true,
      });
    }
  }

  static _loadImage(entries) {
    for (const e of entries) {
      if (e.isIntersecting) {
        const el = e.target;
        const url = el.getAttribute(LAZY_ATTR);

        if (el instanceof HTMLImageElement)
          el.src = url;
        else
          el.style.backgroundImage = `url(${url})`;

        el.removeAttribute(LAZY_ATTR);
        Render.scrollObserver.unobserve(el);
      }
    }
  }
}


class Util {

  static str2num(str) {
    return str && Number(str.replace(/,/g, '')) || undefined;
  }

  static num2str(num) {
    return num && num.toLocaleString() || '';
  }

  static num2pct(n, numDecimals = 2) {
    return (n * 100).toFixed(numDecimals).replace(/\.?0+$/, '') + '%';
  }

  static num2strPlus(fmt, threshold, num) {
    return fmt
      .replace('%n', num + (num >= threshold ? '+' : ''))
      .replace('%s', num !== 1 ? 's' : '');
  }

  static decodeHtml(str) {
    if (str.includes('&#')) {
      str = str.replace(/&#(x?)([\da-f]);/gi, (_, hex, code) =>
        String.fromCharCode(parseInt(code, hex ? 16 : 10)));
    }
    if (!str.includes('&') ||
        !/&\w+;/.test(str))
      return str;
    if (!Mal.parser)
      Mal.parser = new DOMParser();
    const doc = Mal.parser.parseFromString(str, 'text/html');
    return doc.body.firstChild.textContent;
  }

  static parseJson(str) {
    try {
      return JSON.parse(str);
    } catch (e) {}
  }

  static nextTick() {
    return new Promise(setTimeout);
  }
}


/** @return {HTMLElement} */
function $(selector, node = document) {
  return node.querySelector(selector);
}

/** @return {HTMLElement} */
function $id(id, doc = document) {
  return doc.getElementById(id);
}

/** @return {HTMLElement[]} */
function $$(selector, node = document) {
  return [...node.querySelectorAll(selector)];
}

/** @return {String} */
function $text(selector, node = document) {
  const el = typeof selector === 'string' ?
    node.querySelector(selector) :
    selector;
  return el ? el.textContent.trim() : '';
}

/** @return {HTMLElement} */
function $create(tag, props = {}, children) {

  if (!children && (
    props instanceof Node ||
    typeof props !== 'object' ||
    Array.isArray(props)
  )) {
    children = props;
    props = {};
  }

  let ns;
  const i = tag.indexOf(':');
  if (i >= 0) {
    ns = tag.slice(0, i);
    tag = tag.slice(i + 1);
  }

  const el = props.id && $id(props.id) || (
    /^SVG$/i.test(ns) ?
      document.createElementNS('http://www.w3.org/2000/svg', tag) :
      document.createElement(tag));

  const hasOwnProperty = Object.hasOwnProperty;
  for (const k in props) {
    if (!hasOwnProperty.call(props, k))
      continue;
    const v = props[k];
    switch (k) {
      case 'children':
      case 'parent':
      case 'after':
      case 'before':
        continue;
      default: {
        const slice = k.startsWith('$') ? 1 : 0;
        if (slice || ns) {
          if (el.getAttribute(k.slice(slice)) !== v)
            el.setAttribute(k.slice(slice), v);
        } else if (el[k] !== v) {
          el[k] = v;
        }
      }
    }
  }

  if (!children)
    children = props.children;
  if (children) {
    if (el.firstChild)
      el.textContent = '';
    if (typeof children !== 'string' && Symbol.iterator in children)
      el.append(...[...children].filter(Boolean));
    else
      el.append(children);
  }

  if (props.parent && props.parent !== el.parentNode)
    props.parent.appendChild(el);
  if (props.before && props.before !== el.nextSibling)
    props.before.insertAdjacentElement('beforeBegin', el);
  if (props.after && props.after !== el.previousSibling)
    props.after.insertAdjacentElement('afterEnd', el);

  return el;
}

function $createLink(props, children) {
  return $create('a', Object.assign(props, {
    rel: 'noopener noreferrer',
    target: '_blank',
  }), children);
}

App.init();
