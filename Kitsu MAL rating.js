// ==UserScript==
// @name         Kitsu augmented with MAL
// @description  Shows MyAnimeList.net data on Kitsu.io
// @version      1.0.0

// @namespace    https://github.com/tophf
// @author       tophf
// @inspired-by  https://greasyfork.org/scripts/5890

// @match        *://kitsu.io/*

// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow

// @run-at       document-start

// @connect      myanimelist.net
// @connect      kitsu.io
// ==/UserScript==

'use strict';
/* global GM_info GM_xmlhttpRequest unsafeWindow exportFunction */

const API_URL = 'https://kitsu.io/api/edge/';
const MAL_URL = 'https://myanimelist.net/';

const RX_KITSU_TYPE_SLUG = /\/(anime|manga)\/([^/?#]+)(?:[?#].*)?$|$/;
const RX_INTERCEPT = new RegExp(
  '^' + API_URL.replace(/\./g, '\\.') +
  '(anime|manga)\\?.*?&include=');

const SEL_READY_SIGN = 'meta[property="og:url"]';
const SEL_RATING_CONTAINER = '.media-rating';
const ID_RATING = GM_info.script.name + ':rating';

const HOUR = 3600e3;
const CACHE_DURATION = 4 * HOUR;

class App {
  static async init() {
    new XHRInterceptor().subscribe(App.cook);
    new HistoryInterceptor().subscribe(App.onUrlChange);
    window.addEventListener('popstate', () => App.onUrlChange());
    App.onUrlChange();
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
      await App.cook(await App.inquire(type, slug), type, slug);
  }

  static inquire(type, slug) {
    return Get.json(API_URL + type + '?' + [
      'filter[slug]=' + slug,
      'include=mappings',
      'fields[mappings]=externalSite,externalId',
      'fields[anime]=id,type,slug',
    ].join('&'));
  }

  static async cook(payload, type, slug) {
    const url = Mal.findUrl(payload);
    if (!url)
      return;
    if (!type)
      ({type, attributes: {slug}} = payload.data[0]);
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
    if (data.rating !== undefined)
      Rating.render(data);
    App.busy = false;
  }

  static async expire() {
    if (document.getElementById(ID_RATING)) {
      await new Promise(setTimeout);
      if (App.busy)
        Rating.hide();
    }
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

  static async scavenge(url) {
    const doc = await Get.doc(url);
    let el, rating, members, favs;

    el = $('[itemprop="ratingValue"],' +
           '[data-id="info1"] > span:not(.dark_text)', doc);
    rating = $text(el).trim();
    rating = rating && Number(rating.match(/[\d.]+|$/)[0]) || rating || undefined;

    while (!members && !favs && (el = el.nextElementSibling)) {
      const txt = el.textContent;
      members = members || txt.match(/Members:\s*([\d,]+)|$/)[1];
      favs = favs || txt.match(/Favorites:\s*([\d,]+)|$/)[1];
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

class Rating {

  static hide() {
    const el = document.getElementById(ID_RATING);
    if (el)
      el.style.opacity = '0';
  }

  static render({rating: r, url}) {
    const parent = $(SEL_RATING_CONTAINER);
    const quarter = r > 0 && Math.max(1, Math.min(4, 1 + (r - .001) / 2.5 >> 0));
    const textContent = (r > 0 ? (r * 10).toFixed(2).replace(/\.?0+$/, '') + '%' : r) + ' on MAL';
    const el = $create('a', {
      textContent,
      href: url,
      id: ID_RATING,
      className: 'media-community-rating' + (quarter ? 'percent-quarter-' + quarter : ''),
      style: 'transition: opacity 1s; opacity: 1',
      rel: 'noopener noreferrer',
      target: '_blank',
      parent,
    });
    if (el.previousElementSibling)
      el.style.setProperty('margin-left', '1em');
    else
      el.style.removeProperty('margin-left');
  }
}

class Interceptor {
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

class HistoryInterceptor extends Interceptor {
  constructor() {
    super('History', 'pushState', (state, title, url) => {
      for (const fn of this._subscribers)
        fn(url);
    });
  }
}

class XHRInterceptor extends Interceptor {
  constructor() {
    let self;
    super('XMLHttpRequest', 'open', function (method, url, ...args) {
      if (/^get$/i.test(method) &&
          RX_INTERCEPT.test(url)) {
        App.expire();
        this.addEventListener('load', e => self._onload(e), {once: true});
        url = XHRInterceptor._augment(url);
        return [method, url, ...args];
      }
    });
    self = this;
  }

  static _augment(url) {
    const u = new URL(url);
    u.searchParams.set('include', u.searchParams.get('include') + ',mappings');
    u.searchParams.set('fields[mappings]', 'externalSite,externalId');
    return u.href;
  }

  _onload(e) {
    const json = JSON.parse(e.target.responseText);
    for (const fn of this._subscribers)
      fn(json);
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
    const [time, malTID] = (localStorage[key] || '').split(' ');

    if (!time || !malTID)
      return;

    const url = MAL_URL + Mal.expandTypeId(malTID);

    if (Date.now() - parseInt(time, 36) * 60e3 > CACHE_DURATION)
      return {url};

    try {
      return {
        url,
        data: JSON.parse(localStorage[Cache.malKey(malTID)]),
      };
    } catch (e) {}
  }

  static write(type, slug, malFullTypeId, data) {
    const key = Cache.key(type, slug);
    const malTID = Mal.shortenTypeId(malFullTypeId);
    localStorage[key] = Math.floor(Date.now() / 60e3).toString(36) + ' ' + malTID;

    const malKey = Cache.malKey(malTID);
    const dataStr = JSON.stringify(data);
    if (dataStr !== '{}')
      localStorage[malKey] = dataStr;
    else
      delete localStorage[malKey];
  }

  static key(type, slug) {
    return `:${type.slice(0, 1)}:${slug}`;
  }

  static malKey(malTID) {
    return ':MAL:' + malTID;
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

class Mutant {

  static ogUrl(data) {
    const url = TypeSlug.toUrl(data);
    const el = $(SEL_READY_SIGN);
    if (el && el.content === url)
      return Promise.resolve();
    if (!Mutant._state)
      Mutant._init();
    Mutant._state.url = url;
    return new Promise(Mutant.subscribe);
  }

  static subscribe(fn) {
    Mutant._state.subscribers.add(fn);
    if (!Mutant._state.active)
      Mutant._start();
  }

  static _init() {
    Mutant._state = {
      active: false,
      subscribers: new Set(),
      observer: new MutationObserver(Mutant._observer),
      url: '',
    };
  }

  static _start() {
    Mutant._state.observer.observe(document.head, {childList: true});
    Mutant._state.observer.active = true;
  }

  static _resolve() {
    Mutant._state.observer.disconnect();
    Mutant._state.observer.active = false;
    Mutant._state.subscribers.forEach(fn => fn.apply(null, arguments));
    Mutant._state.subscribers.clear();
  }

  static _observer(mm) {
    for (var i = 0, m; (m = mm[i++]);) {
      for (var j = 0, added = m.addedNodes, n; (n = added[j++]);) {
        if (n.localName === 'meta' &&
            n.content === Mutant._state.url) {
          Mutant._resolve();
          return;
        }
      }
    }
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

function $(selector, node = document) {
  return node.querySelector(selector);
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

function $create(tag, props) {
  let parent, after, before;
  const el = props.id && document.getElementById(props.id) || document.createElement(tag);
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
    before.insertAdjacentElement('beforebegin', el);
  if (after && after !== el.previousSibling)
    after.insertAdjacentElement('aftereend', el);
  return el;
}

App.init();
