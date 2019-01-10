// ==UserScript==
// @name         Kitsu MALonnaised
// @description  Shows MyAnimeList.net data on Kitsu.io
// @version      1.0.0

// @namespace    https://github.com/tophf
// @author       tophf
// @inspired-by  https://greasyfork.org/scripts/5890

// @match        *://kitsu.io/*

// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow

// @require      https://greasyfork.org/scripts/27531/code/LZStringUnsafe.js
// @run-at       document-start

// @connect      myanimelist.net
// @connect      kitsu.io
// ==/UserScript==

'use strict';
/* global GM_info GM_xmlhttpRequest GM_addStyle unsafeWindow exportFunction */
/* global LZStringUnsafe */

const API_URL = 'https://kitsu.io/api/edge/';
const MAL_URL = 'https://myanimelist.net/';
const MAL_CDN_URL = 'https://cdn.myanimelist.net/';
let MAL_IMG_EXT = '.jpg';

const RX_INTERCEPT = new RegExp(
  '^' + API_URL.replace(/\./g, '\\.') +
  '(anime|manga)\\?.*?&include=');

const ID = (me => ({
  BASE: me,
  SCORE: `${me}:SCORE`,
  USERS: `${me}:USERS`,
  FAVS: `${me}:FAVS`,
  CHARS: `${me}:CHARS`,
  RECS: `${me}:RECS`,
}))(GM_info.script.name);

const HOUR = 3600e3;
const CACHE_DURATION = 4 * HOUR;


class App {
  static async init() {
    new InterceptXHR().subscribe(App.cook);
    new InterceptHistory().subscribe(App.onUrlChange);
    window.addEventListener('popstate', () => App.onUrlChange());
    App.onUrlChange();

    // detect WebP support
    $create('img', {
      src: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
      onload() {
        MAL_IMG_EXT = '.webp';
      },
    });

    const RECS_MIN_HEIGHT = 250;
    const RECS_MAX_HEIGHT = RECS_MIN_HEIGHT * 10;
    const RECS_TRANSITION_TIMING = '.5s .25s';

    if (document.readyState !== 'complete')
      await new Promise(resolve => addEventListener('load', resolve, {once: true}));
    const bgColor = getComputedStyle(document.body).backgroundColor;

    // language=CSS
    GM_addStyle(`
      #SCORE:hover,
      [id^="${CSS.escape(ID.BASE)}:"] a:hover {
        text-decoration: underline;
      }
      ${Object.keys(ID).map(id => '#' + id).join(',')} {
        transition: opacity .25s;
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
      .media--sidebar .is-sticky {
        position: static !important;
      }
      #CHARS h5 a {
        font: inherit;
      }
      #CHARS[type="anime"] li a {
        width: 50%;
      }
      #CHARS[type="manga"] li {
        width: calc(50% - 4px);
        display: inline-block;
      }
      #CHARS[type="manga"] li:nth-child(odd) {
        margin-right: 8px;
      }
      #CHARS a[href*="/people/"] {
        opacity: .5;
        will-change: opacity;
        transition: opacity .25s .1s;
      }
      #CHARS a[href*="/people/"] img {
        opacity: .3;
        will-change: opacity;
        transition: opacity .25s .1s;
      }
      #CHARS:hover a[href*="/people/"] img {
        opacity: .6;
      }
      #CHARS a[href*="/people/"]:hover,
      #CHARS a[href*="/people/"] img:hover {
        opacity: 1;
      }
      #CHARS a:first-child {
        font-weight: bold;
      }
      #CHARS a[href*="/people/"]:only-child,
      #CHARS img {
        width: 100%;
      }
      #CHARS p {
        height: 33%;
      }
      #CHARS small {
        display: block;
        margin-bottom: 8px;
      }
      #RECS {
        margin-bottom: 1em;
        max-height: ${RECS_MIN_HEIGHT}px;
        overflow: hidden;
        transition: max-height ${RECS_TRANSITION_TIMING};
      }
      #RECS:hover {
        max-height: ${RECS_MAX_HEIGHT}px;
      }
      #RECS::before {
        background: linear-gradient(transparent 33%, ${bgColor});
        position: absolute;
        display: block;
        content: "";
        width: 100%;
        z-index: 999;
        min-height: ${RECS_MIN_HEIGHT}px;
        pointer-events: none;
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
        margin: 0;
        padding: 0;
      }
      #RECS li {
        list-style: none;
        margin-right: .5rem;
      }
      #RECS li > a {
        width: 180px;
        display: block;
        font-size: 13px;
        margin-top: -.25em;
      }
      #RECS div {
        max-height: 255px;
        overflow: hidden;
      }
      #RECS p {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding: 0;
        margin: 0;
      }
      #RECS small {
        font-size: 10px;
        opacity: .5;
      }
      #RECS li:hover small {
        opacity: 1;
      }
      #RECS > a {
        font-weight: bold;
      }
      #RECS img {
        margin:  -2px;
        max-width: calc(100% + 4px);
      }
    `.replace(
      /#([A-Z]+)/g,
      (_, id) => `#${CSS.escape(ID[id])}`)
    );
  }

  static async onUrlChange(path = location.pathname) {
    const [type, slug] = TypeSlug.fromUrl(path);
    if (!slug)
      return;
    let {url, data} = Cache.read(type, slug) || {};
    if (!data)
      App.hide();
    if (url && !data)
      data = await Mal.scavenge(url);
    if (data)
      App.plant(Object.assign({url, type, slug}, data));
    else
      await App.cook(await App.inquire(type, slug));
  }

  static inquire(type, slug) {
    return Get.json(API_URL + type + '?' + [
      'filter[slug]=' + slug,
      'include=mappings',
      'fields[mappings]=externalSite,externalId',
      'fields[anime]=id,type,slug',
    ].join('&'));
  }

  static async cook(payload) {
    const url = Mal.findUrl(payload);
    if (!url)
      return;
    const {type, attributes: {slug}} = payload.data[0];
    let {data} = Cache.read(type, slug) || {};
    if (!data) {
      App.busy = true;
      data = await Mal.scavenge(url);
      Cache.write(type, slug, url.slice(MAL_URL.length), data);
      App.busy = false;
    }
    App.plant(Object.assign({type, slug, url}, data));
  }

  static async plant(data = {}) {
    await Mutant.ogUrl(data);
    Render.stats(data);
    Render.characters(data);
    Render.recommendations(data);
    App.busy = false;
  }

  static async hide() {
    if (!$id(ID.SCORE))
      return;
    await Util.nextTick();
    if (!App.busy)
      return;
    for (const el of $$(`[id^="${CSS.escape(ID.BASE)}:"]`))
      el.style.setProperty('opacity', '0');
  }
}


class Cache {
  /**
   * @param {String} type
   * @param {String} slug
   * @return {{url:String, data?:Object}|void}
   */
  static read(type, slug) {
    const key = Cache.key(type, slug);
    const [time, TID] = (localStorage[key] || '').split(' ');

    if (!time || !TID)
      return;

    const url = MAL_URL + Mal.expandTypeId(TID);

    if (Cache.expired(time))
      return {url};

    const malKey = Cache.malKey(TID);
    try {
      const data = Cache.unpackProps(localStorage[malKey]);
      return {url, data};
    } catch (e) {
      delete localStorage[malKey];
      return {url};
    }
  }

  static async write(type, slug, malFullTypeId, data) {
    const key = Cache.key(type, slug);
    const TID = Mal.shortenTypeId(malFullTypeId);
    localStorage[key] = Math.floor(Date.now() / 60e3).toString(36) + ' ' + TID;

    const malKey = Cache.malKey(TID);
    if (Util.isEmpty(data)) {
      delete localStorage[malKey];
      return;
    }
    await Util.nextTick();
    const dataStr = Object.entries(data).map(Cache.packProp).join('\n');
    localStorage[malKey] = dataStr;
  }

  static packProp([k, v]) {
    if (typeof v !== 'object')
      return k + '\t' + v;
    const str = JSON.stringify(v);
    return str.length > 50 ?
      k + '|z\t' + LZStringUnsafe.compressToUTF16(str) :
      k + '|j\t' + str;
  }

  static unpackProps(dataStr) {
    const data = {};
    for (const str of dataStr.split('\n')) {
      const i = str.indexOf('\t');
      const [k, fmt] = str.slice(0, i).split('|');
      let v = str.slice(i + 1);
      switch (fmt) {
        case 'z':
          v = LZStringUnsafe.decompressFromUTF16(v);
          // fallthrough to 'j'
        case 'j':
          v = JSON.parse(v);
          break;
        default: {
          const num = Number(v);
          if (!isNaN(num))
            v = num;
          break;
        }
      }
      data[k] = v;
    }
    return data;
  }

  static expired(time) {
    return Date.now() - parseInt(time, 36) * 60e3 > CACHE_DURATION;
  }

  static key(type, slug) {
    return `:${type.slice(0, 1)}:${slug}`;
  }

  static malKey(malTID) {
    return ':MAL:' + malTID;
  }
}


class Get {

  static json(url) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        url,
        method: 'GET',
        responseType: 'json',
        headers: {
          'Accept': 'application/vnd.api+json',
        },
        onload: r => resolve(r.response),
      });
    });
  }

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


class Mal {

  static expandTypeId(short) {
    const t = short.slice(0, 1);
    const fullType = t === 'a' && 'anime' ||
                     t === 'm' && 'manga' ||
                     t === 'c' && 'character' ||
                     t === 'p' && 'people' ||
                     '';
    return fullType + '/' + short.slice(1);
  }

  static shortenTypeId(full) {
    return full.slice(0, 1) + full.split('/')[1];
  }

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


class Intercept {
  constructor(name, method, fn) {
    this._subscribers = new Set();
    const original = unsafeWindow[name].prototype[method];
    unsafeWindow[name].prototype[method] = exportFunction(function () {
      const augmentedArgs = fn.apply(this, arguments);
      return original.apply(this, augmentedArgs || arguments);
    }, unsafeWindow);
  }

  subscribe(fn) {
    this._subscribers.add(fn);
  }
}


class InterceptHistory extends Intercept {
  constructor() {
    super('History', 'pushState', (state, title, url) => {
      for (const fn of this._subscribers)
        fn(url);
    });
  }
}


class InterceptXHR extends Intercept {
  constructor() {
    let self;
    super('XMLHttpRequest', 'open', function (method, url, ...args) {
      if (/^get$/i.test(method) &&
          RX_INTERCEPT.test(url)) {
        App.hide();
        this.addEventListener('load', e => self.onload(e), {once: true});
        url = InterceptXHR.augment(url);
        return [method, url, ...args];
      }
    });
    self = this;
  }

  static augment(url) {
    const u = new URL(url);
    u.searchParams.set('include', u.searchParams.get('include') + ',mappings');
    u.searchParams.set('fields[mappings]', 'externalSite,externalId');
    return u.href;
  }

  onload(e) {
    const json = JSON.parse(e.target.responseText);
    for (const fn of this._subscribers)
      fn(json);
  }
}


class Mutant {

  static ogUrl(data) {
    const url = TypeSlug.toUrl(data);
    const el = $('meta[property="og:url"]');
    if (el && el.content === url)
      return Promise.resolve();
    if (!Mutant._state)
      Mutant.init();
    Mutant._state.url = url;
    return new Promise(Mutant.subscribe);
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

  static num2str(num) {
    return num && num.toLocaleString() || '';
  }

  static stats({score: [r, count] = ['N/A'], users, favs, url} = {}) {
    const quarter = r > 0 && Math.max(1, Math.min(4, 1 + (r - .001) / 2.5 >> 0));
    const str = (r > 0 ? (r * 10).toFixed(2).replace(/\.?0+$/, '') + '%' : r) + ' on MAL';
    $createLink({
      textContent: str,
      title: count && `Scored by ${Render.num2str(count)} users` || '',
      href: url,
      id: ID.SCORE,
      parent: $('.media-rating'),
      className: 'media-community-rating' + (quarter ? ' percent-quarter-' + quarter : ''),
      '*style': '',
    });
    $create('span', {
      id: ID.USERS,
      after: $id(ID.SCORE),
      textContent: Render.num2str(users),
      '*style': users ? '' : 'opacity:0',
    });
    $create('span', {
      id: ID.FAVS,
      after: $id(ID.USERS),
      textContent: Render.num2str(favs),
      '*style': favs ? '' : 'opacity:0',
    });
  }

  static characters({chars, url, type, slug}) {
    $create('section', {
      id: ID.CHARS,
      parent: $('.media-summary'),
      className: 'media--related',
      '*style': chars ? '' : 'opacity:0',
      '*type': type,
    }, [
      $create('div', {className: 'related-media-panel'}, [
        $create('h5', [
          $createLink({href: `${url}/${slug}/characters`}, 'Characters on MAL'),
        ]),
        $create('ul',
          chars.map(([type, [char, charId, charImg], [va, vaId, vaImg] = []]) =>
            $create('li', [
              char &&
              $createLink({href: MAL_URL + 'character/' + charId}, [
                charImg ?
                  $create('img', {
                    src: MAL_CDN_URL + 'images/characters/' + charImg + MAL_IMG_EXT,
                  }) :
                  $create('p'),
                $create('div', char),
                $create('small', type),
              ]),
              va &&
              $createLink({href: MAL_URL + 'people/' + vaId}, [
                vaImg &&
                $create('img', {src: MAL_CDN_URL + 'images/voiceactors/' + vaImg + '.jpg'}),
                $create('div', va),
                !char &&
                $create('small', type),
              ]),
            ])
          )
        ),
      ]),
    ]);
  }

  static recommendations({recs, url, type, slug}) {
    const mainId = url.match(/\d+/)[0];
    $create('section', {
      id: ID.RECS,
      before: $('.media--reactions'),
      '*style': recs ? '' : 'opacity:0',
    }, [
      $createLink({href: `${url}/${slug}/userrecs`}, 'Recommendations on MAL'),
      $create('ul',
        recs.map(([name, id, img, count]) =>
          $create('li', [
            $create('small',
              !count ?
                'auto-rec' :
                $createLink({href: `${MAL_URL}recommendations/${type}/${id}-${mainId}`},
                  count + ' rec' + (count > 1 ? 's' : ''))),
            $createLink({href: `${MAL_URL}${type}/${id}`}, [
              $create('p', name),
              $create('div',
                $create('img', {src: `${MAL_CDN_URL}images/${type}/${img}${MAL_IMG_EXT}`})),
            ]),
          ]))),
    ]);
  }
}


class TypeSlug {

  static fromUrl(url = location.pathname) {
    const m = url.match(/\/(anime|manga)\/([^/?#]+)(?:[?#].*)?$|$/);
    return m ? m.slice(1) : [];
  }

  static toUrl({type, slug}) {
    return `${location.origin}/${type}/${slug}`;
  }
}


class Util {

  static str2num(str) {
    return str && Number(str.replace(/,/g, '')) || undefined;
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

  static isEmpty(obj) {
    for (const k in obj) {
      if (obj[k] !== undefined)
        return false;
    }
    return true;
  }

  static nextTick() {
    return new Promise(setTimeout);
  }
}


function $(selector, node = document) {
  return node.querySelector(selector);
}

function $id(id, doc = document) {
  return doc.getElementById(id);
}

function $$(selector, node = document) {
  return [...node.querySelectorAll(selector)];
}

function $text(selector, node = document) {
  const el = typeof selector === 'string' ?
    node.querySelector(selector) :
    selector;
  return el ? el.textContent.trim() : '';
}

function $create(tag, props = {}, children) {
  if (!children && (
    props instanceof Node ||
    typeof props !== 'object' ||
    Array.isArray(props)
  )) {
    children = props;
    props = {};
  }
  const el = props.id && $id(props.id) || document.createElement(tag);
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
      default:
        if (k.startsWith('*')) {
          if (el.getAttribute(k.slice(1)) !== v)
            el.setAttribute(k.slice(1), v);
        } else if (el[k] !== v) {
          el[k] = v;
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
