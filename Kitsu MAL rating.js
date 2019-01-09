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

// @run-at       document-start

// @connect      myanimelist.net
// @connect      kitsu.io
// ==/UserScript==

'use strict';
/* global GM_info GM_xmlhttpRequest GM_addStyle unsafeWindow exportFunction */

const API_URL = 'https://kitsu.io/api/edge/';
const MAL_URL = 'https://myanimelist.net/';

const RX_KITSU_TYPE_SLUG = /\/(anime|manga)\/([^/?#]+)(?:[?#].*)?$|$/;
const RX_INTERCEPT = new RegExp(
  '^' + API_URL.replace(/\./g, '\\.') +
  '(anime|manga)\\?.*?&include=');

const SEL_READY_SIGN = 'meta[property="og:url"]';
const SEL_RATING_CONTAINER = '.media-rating';

const ID = (me => ({
  RATING: `${me}:RATING`,
  MEMBERS: `${me}:MEMBERS`,
  FAVS: `${me}:FAVS`,
}))(GM_info.script.name);

const HOUR = 3600e3;
const CACHE_DURATION = 4 * HOUR;


class App {
  static async init() {
    new InterceptXHR().subscribe(App.cook);
    new InterceptHistory().subscribe(App.onUrlChange);
    window.addEventListener('popstate', () => App.onUrlChange());
    App.onUrlChange();

    // language=CSS
    GM_addStyle(`
      ${Object.keys(ID).map(id => '#' + id).join(',')} {
        transition: opacity .5s;
      }
      #RATING:not(:first-child),
      #MEMBERS,
      #FAVS {
        margin-left: 1em;
      }
      #MEMBERS::before {
        content: '\\1F464';
        margin-right: .25em;
      }
      #FAVS::before {
        content: '\\2764';
        margin-right: .25em;
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
      App.expire();
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
    Render.rating(data);
    Render.users(data);
    App.busy = false;
  }

  static async expire() {
    const elements = [
      $id(ID.RATING),
    ];
    if (!elements.length)
      return;
    await new Promise(setTimeout);
    if (!App.busy)
      return;
    for (const el of elements)
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
      const data = JSON.parse(localStorage[malKey]);
      return {url, data};
    } catch (e) {
      delete localStorage[malKey];
      return {url};
    }
  }

  static write(type, slug, malFullTypeId, data) {
    const key = Cache.key(type, slug);
    const TID = Mal.shortenTypeId(malFullTypeId);
    localStorage[key] = Math.floor(Date.now() / 60e3).toString(36) + ' ' + TID;

    const malKey = Cache.malKey(TID);
    const dataStr = JSON.stringify(data);
    if (dataStr !== '{}')
      localStorage[malKey] = dataStr;
    else
      delete localStorage[malKey];
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

  static findImgIds(img) {
    // https://cdn.myanimelist.net/r/23x32/images/characters/7/331067.webp?s=xxxxxxxxxx
    const {src} = img.dataset;
    return src && src.match(/\d+\/\d+\.\w+|$/)[0];
  }

  static findUrlIds(el) {
    // https://myanimelist.net/character/101457/Chika_Kudou
    const a = el.closest('a');
    return a && a.href.match(/\d+\/[^/]+$|$/)[0];
  }

  static str2num(str) {
    return str && Number(str.replace(/,/g, '')) || undefined;
  }

  static async scavenge(url) {
    const doc = await Get.doc(url);
    let el, rating, members, favs;

    el = $('[itemprop="ratingValue"],' +
           '[data-id="info1"] > span:not(.dark_text)', doc);
    rating = $text(el).trim();
    rating = rating && Number(rating.match(/[\d.]+|$/)[0]) || rating || undefined;
    rating = rating && [
      rating,
      Mal.str2num($text('[itemprop="ratingCount"]', doc)),
    ];

    while (el.parentElement &&
           !el.parentElement.textContent.includes('Members:'))
      el = el.parentElement;
    while ((!members || !favs) &&
           (el = el.nextElementSibling)) {
      const txt = el.textContent;
      members = members || Mal.str2num(txt.match(/Members:\s*([\d,]+)|$/)[1]);
      favs = favs || Mal.str2num(txt.match(/Favorites:\s*([\d,]+)|$/)[1]);
    }

    const chars = $$('.detail-characters-list table[width]', doc).map(el => {
      const char = $('img', el);
      const actor = $('a[href*="/people/"] img', el);
      return [
        char.alt,
        Mal.findUrlIds(char),
        Mal.findImgIds(char),
        $text('small', el),
      ].concat(actor && actor !== char && [
        actor.alt,
        Mal.findUrlIds(actor),
        Mal.findImgIds(actor),
      ] || []);
    });

    const recs = $$('#anime_recommendation .link', doc).map(a => [
      $text('.title', a),
      parseInt($text('.users', a)) || 0,
      a.href.match(/\d+-\d+|$/)[0],
      Mal.findImgIds($('img', a)),
    ]);

    return {rating, members, favs, chars, recs};
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
        App.expire();
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
    const el = $(SEL_READY_SIGN);
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

  static rating({rating: [r, count] = ['N/A'], url} = {}) {
    const quarter = r > 0 && Math.max(1, Math.min(4, 1 + (r - .001) / 2.5 >> 0));
    const str = (r > 0 ? (r * 10).toFixed(2).replace(/\.?0+$/, '') + '%' : r) + ' on MAL';
    $create('a', {
      textContent: str,
      title: count && `Scored by ${Render.num2str(count)} users` || '',
      href: url,
      id: ID.RATING,
      parent: $(SEL_RATING_CONTAINER),
      className: 'media-community-rating' + (quarter ? ' percent-quarter-' + quarter : ''),
      rel: 'noopener noreferrer',
      target: '_blank',
    });
  }

  static users({members, favs}) {
    $create('span', {
      id: ID.MEMBERS,
      after: $id(ID.RATING),
      textContent: Render.num2str(members),
      style: members ? '' : 'opacity:0',
    });
    $create('span', {
      id: ID.FAVS,
      after: $id(ID.MEMBERS),
      textContent: Render.num2str(favs),
      style: favs ? '' : 'opacity:0',
    });
  }
}


class TypeSlug {

  static fromUrl(url = location.pathname) {
    const m = url.match(RX_KITSU_TYPE_SLUG);
    return m ? m.slice(1) : [];
  }

  static toUrl({type, slug}) {
    return `${location.origin}/${type}/${slug}`;
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

function $create(tag, props) {
  let parent, after, before;
  const el = props.id && $id(props.id) || document.createElement(tag);
  const hasOwnProperty = Object.hasOwnProperty;
  for (const k in props) {
    if (!hasOwnProperty.call(props, k))
      continue;
    const v = props[k];
    switch (k) {
      case 'children':
        if (el.firstChild)
          el.textContent = '';
        if (Symbol.iterator in v && typeof v !== 'string')
          el.append(...v);
        else
          el.append(v);
        continue;
      case 'parent':
        parent = v;
        continue;
      case 'after':
        after = v;
        continue;
      case 'before':
        before = v;
        continue;
      default:
        if (el[k] !== v)
          el[k] = v;
    }
  }
  if (parent && parent !== el.parentNode)
    parent.appendChild(el);
  if (before && before !== el.nextSibling)
    before.insertAdjacentElement('beforeBegin', el);
  if (after && after !== el.previousSibling)
    after.insertAdjacentElement('afterEnd', el);
  return el;
}

function $text(selector, node = document) {
  const el = typeof selector === 'string' ?
    node.querySelector(selector) :
    selector;
  return el ? el.textContent.trim() : '';
}

App.init();
