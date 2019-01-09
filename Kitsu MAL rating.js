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

const SEL_READY_SIGN = 'meta[property="og:url"]';
const SEL_RATING_CONTAINER = '.media-rating';

const SEL_MAL_RATING = '[itemprop="ratingValue"],' +
                       '[data-id="info1"] > span:not(.dark_text)';

const RX_KITSU_TYPE_SLUG = /\/(anime|manga)\/([^/?#]+)(?:[?#].*)?$|$/;
const RX_INTERCEPT = new RegExp(
  '^' + API_URL.replace(/\./g, '\\.') +
  '(anime|manga)\\?.*?&include=');

const HOUR = 3600e3;
const CACHE_DURATION = 4 * HOUR;

class App {
  static async init() {
    new XHRInterceptor().subscribe(App.cook);
    new HistoryInterceptor().subscribe(App.onUrlChange);
    window.addEventListener('popstate', () => App.onUrlChange());
    App.onUrlChange();
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
    const url = App.findMalUrl(payload);
    if (!url)
      return;
    if (!type)
      ({type, attributes: {slug}} = payload.data[0]);
    let {data} = Cache.read(type, slug) || {};
    if (!data) {
      App.busy = true;
      data = await Get.malData(url);
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
    const shown = Boolean(document.getElementById(Rating.id));
    if (!shown)
      return;
    await new Promise(setTimeout);
    if (App.busy)
      Rating.hide();
  }

  static findMalUrl(data) {
    for (const {type, attributes: a} of data.included || []) {
      if (type === 'mappings' &&
          a.externalSite.startsWith('myanimelist')) {
        const malType = a.externalSite.split('/')[1];
        const malId = a.externalId;
        return MAL_URL + malType + '/' + malId;
      }
    }
  }

  static async onUrlChange(path = location.pathname) {
    const [type, slug] = TypeSlug.fromUrl(path);
    if (!slug)
      return;
    let {url, data} = Cache.read(type, slug) || {};
    if (!data)
      App.expire();
    if (url && !data)
      data = await Get.malData(url);
    if (data)
      App.plant(Object.assign({url, type, slug}, data));
    else
      await App.cook(await App.inquire(type, slug), type, slug);
  }
}

class Rating {

  static get id() {
    return GM_info.script.name + ':rating';
  }

  static hide() {
    const el = document.getElementById(Rating.id);
    if (el)
      el.style.opacity = '0';
  }

  static render({rating, url}) {
    const parent = $(SEL_RATING_CONTAINER);
    const quarter = rating > 0 && Math.max(1, Math.min(4, 1 + (rating - .001) / 2.5 >> 0));
    const el = $create('a', {
      id: Rating.id,
      className: [
        'media-community-rating',
        quarter ? 'percent-quarter-' + quarter : '',
      ].join(' '),
      textContent: `${
        rating > 0 ?
          (rating * 10).toFixed(2).replace(/\.?0+$/, '') + '%' :
          rating
        } on MAL`,
      href: url,
      style: [
        'transition: opacity .5s',
        'opacity: 1',
      ].join(';'),
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
    const key = type + ':' + slug;
    const [time, malTypeId] = (localStorage[key] || '').split(' ');

    if (!time || !malTypeId)
      return;

    const url = MAL_URL + malTypeId;

    if (Date.now() - parseInt(time, 36) > CACHE_DURATION)
      return {url};

    try {
      return {
        url,
        data: JSON.parse(localStorage[key + ':MAL']),
      };
    } catch (e) {}
  }

  static write(type, slug, malTypeId, data) {
    const dataStr = JSON.stringify(data);
    if (dataStr === '{}')
      return;
    const key = type + ':' + slug;
    localStorage[key] = Date.now().toString(36) + ' ' + malTypeId;
    localStorage[key + ':MAL'] = dataStr;
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

  static async malData(url) {
    const doc = await Get.doc(url);
    let rating = $text(SEL_MAL_RATING, doc).trim();
    rating = rating && Number(rating.match(/[\d.]+|$/)[0]) || rating || undefined;
    return {rating};
  }
}

function $(selector, node = document) {
  return node && node.querySelector(selector);
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
