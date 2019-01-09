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
const HOUR = 3600e3;
const CACHE_DURATION = 4 * HOUR;

async function main() {
  new XHRInterceptor().subscribe(data => process(data).then(plant));
  new HistoryInterceptor().subscribe((state, title, url) => onUrlChange(url));
  addEventListener('popstate', () => onUrlChange());
  onUrlChange();
}

async function onUrlChange(path = location.pathname) {
  const [type, slug] = TypeSlug.fromUrl(path);
  if (!slug)
    return;
  let {url, data} = Cache.read(type, slug) || {};
  if (!data && document.getElementById(Rating.id)) {
    await Observe.byTitle();
    Rating.remove();
  }
  if (url && !data)
    data = await Get.malData(url);
  if (!data)
    data = await process(await inquire(type, slug), type, slug);
  if (data)
    plant(Object.assign({url, type, slug}, data));
}

function inquire(type, slug) {
  return Get.json(API_URL + type + '?' + [
    'filter[slug]=' + slug,
    'include=mappings',
    'fields[mappings]=externalSite,externalId',
    'fields[anime]=id,type,slug',
  ].join('&'));
}

async function process(payload, type, slug) {
  const url = findMalUrl(payload);
  if (!url)
    return;
  if (!type)
    ({type, attributes: {slug}} = payload.data[0]);
  let {data} = Cache.read(type, slug) || {};
  if (!data) {
    data = await Get.malData(url);
    Cache.write(type, slug, url.slice(MAL_URL.length), data);
  }
  return Object.assign({type, slug, url}, data);
}

async function plant(data = {}) {
  if (!location.pathname === TypeSlug.toPath(data))
    return;
  await Observe.byTitle();
  Rating.render(data);
}

function findMalUrl(data) {
  for (const {type, attributes: a} of data.included || []) {
    if (type === 'mappings' &&
        a.externalSite.startsWith('myanimelist')) {
      const malType = a.externalSite.split('/')[1];
      const malId = a.externalId;
      return MAL_URL + malType + '/' + malId;
    }
  }
}

class Rating {
  static get id() {
    return GM_info.script.name + ':rating';
  }
  static remove() {
    const el = document.getElementById(Rating.id);
    if (el)
      el.remove();
  }
  static render(data) {
    Rating.data = data;
    Rating._attach($('.media-rating'));
  }
  static _attach(parent) {
    const {rating, url} = Rating.data;
    $create('span', {
      id: Rating.id,
      className: [
        'media-community-rating',
        'percent-quarter-' + Math.max(1, Math.min(4, 1 + (rating - .001) / 2.5 >> 0)),
      ].join(' '),
      style: [
        parent.firstElementChild ? 'margin-left: 1em' : '',
        'transition: opacity .5s',
        // 'opacity: 0',
      ].join(';'),
      children: [
        $create('a', {
          textContent: (rating * 10).toFixed(2).replace(/\.?0+$/, '') + '% on MAL',
          href: url,
          rel: 'noopener noreferrer',
          target: '_blank',
          style: [
            'color: inherit',
            'font-family: inherit',
          ].join(';'),
        }),
      ],
      parent,
    });
    // setTimeout(() => el.style.removeProperty('opacity'));
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
    const key = type + ':' + slug;
    localStorage[key] = Date.now().toString(36) + ' ' + malTypeId;
    localStorage[key + ':MAL'] = JSON.stringify(data);
  }
}

class TypeSlug {
  static fromUrl(url = location.pathname) {
    const m = url.match(RX_KITSU_TYPE_SLUG);
    return m ? m.slice(1) : [];
  }
  static toPath({type, slug}) {
    return `/${type}/${slug}`;
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
    const rating = Number($text('[itemprop="ratingValue"]', doc).match(/[\d.]+|$/)[0]);
    return {rating};
  }
}

class Observe {

  static byTitle() {
    const state = Observe._title || Observe._initTitle();
    return new Promise(state.subscribe);
  }

  static byClass(cls) {
    const collection = document.getElementsByClassName(cls);
    const el = collection[0];
    if (el)
      return Promise.resolve(el);
    const state = Observe._elements || Observe._initElements();
    state.collection = collection;
    return new Promise(state.subscribe);
  }

  static _init({node, options, onMutation}) {
    const state = {
      active: false,
      subscribers: new Set(),
      observer: new MutationObserver(onMutation),
      node: node || document,
      options: options || {
        childList: true,
        subtree: true,
      },
      start() {
        state.observer.observe(state.node, state.options);
        state.observer.active = true;
      },
      resolve() {
        state.observer.disconnect();
        state.observer.active = false;
        state.subscribers.forEach(fn => fn.apply(this, arguments));
        state.subscribers.clear();
      },
      subscribe(fn) {
        state.subscribers.add(fn);
        if (!state.active)
          state.start();
      },
    };
    return state;
  }

  static _initElements() {
    const state = Observe._elements = Observe._init({
      onMutation() {
        var el = state.collection[0];
        if (el)
          state.resolve(el);
      },
    });
    return state;
  }

  static _initTitle() {
    const state = Observe._title = Observe._init({
      node: document.head,
      options: {childList: true},
      onMutation(mm) {
        for (var i = 0, m; (m = mm[i++]);) {
          for (var j = 0, added = m.addedNodes, n; (n = added[j++]);) {
            if (n.localName === 'title') {
              state.resolve();
              return;
            }
          }
        }
      },
    });
    return state;
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

main();
