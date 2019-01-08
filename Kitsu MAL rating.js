// ==UserScript==
// @name         Kitsu: MAL rating
// @description  Shows MyAnimeList.net rating on Kitsu.io
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
/* global GM_xmlhttpRequest unsafeWindow exportFunction */

const API = 'https://kitsu.io/api/edge/';
const MAL = 'https://myanimelist.net/';
// https://media.kitsu.io/anime/poster_images/11578/tiny.jpg?1465506853
const RX_KITSU_TYPE_ID = /\/(anime|manga).*?\/(\d+)\/|$/;

async function run() {
  const type = location.pathname.split('/', 2)[1];
  const method = getMappingsByKnownId() || Interceptor.getMappings(API + type);
  const malId = getMalId(await method);
  if (malId)
    plantMalData(await getMalData(type, malId));
}

function getMappingsByKnownId() {
  const el = $('meta[property="og:image"]');
  if (!el)
    return;
  const [, type, id] = el.content.match(RX_KITSU_TYPE_ID);
  if (!id)
    return;
  return getJson(
    `${API}${type}/${id}?` + [
      'include=mappings',
      'fields[mappings]=externalSite,externalId',
      'fields[anime]=id',
    ].join('&'));
}

function getMalId(mappings) {
  for (const {type, attributes: a} of mappings.included || []) {
    if (type === 'mappings' &&
        a.externalSite.startsWith('myanimelist'))
      return a.externalId;
  }
}

async function getMalData(type, id) {
  const url = MAL + type + '/' + id;
  const doc = await getDoc(url);
  const rating = Number($text('[itemprop="ratingValue"]', doc).match(/[\d.]+|$/)[0]);
  return {url, rating};
}

function plantMalData({url, rating}) {
  if (rating) {
    let a;
    $create('span', {
      className: [
        'media-community-rating',
        'percent-quarter-' +
        Math.max(1, Math.min(4, 1 + (rating - .01) / 2.5 >> 0)),
      ].join(' '),
      style: 'margin-left:2em',
      children:
        a = $create('a', {
          textContent: rating * 10 + '% on MAL',
          href: url,
          rel: 'noopener noreferrer',
          target: '_blank',
          style: [
            'color: inherit',
            'font-family: inherit',
            'opacity: 0',
            'transition: opacity .5s',
          ].join(';'),
        }),
      parent: $('.media-rating'),
    });
    setTimeout(() => a.style.removeProperty('opacity'));
  }
}

function getJson(urlOrOptions) {
  return new Promise((resolve, reject) => {
    if (!urlOrOptions.url)
      urlOrOptions = {url: urlOrOptions};
    GM_xmlhttpRequest(Object.assign({
      method: 'GET',
      responseType: 'json',
      headers: {
        'Accept': 'application/vnd.api+json',
      },
    }, urlOrOptions, {
      onload: r => resolve(r.response),
      onerror: reject,
      ontimeout: reject,
    }));
  });
}

function getDoc(urlOrOptions) {
  return new Promise((resolve, reject) => {
    if (!urlOrOptions.url)
      urlOrOptions = {url: urlOrOptions};
    if (!urlOrOptions.method)
      urlOrOptions.method = 'GET';
    GM_xmlhttpRequest(Object.assign(urlOrOptions, {
      onload: r => resolve(new DOMParser().parseFromString(r.response, 'text/html')),
      onerror: reject,
      ontimeout: reject,
    }));
  });
}

class Interceptor {

  static getMappings(urlPrefix) {
    const proto = unsafeWindow.XMLHttpRequest.prototype;
    Interceptor.originalOpen = proto.open;
    Interceptor.urlPrefix = urlPrefix;
    proto.open = exportFunction(Interceptor._open, unsafeWindow);
    return new Promise(Interceptor._run);
  }

  static _run(resolve, reject) {
    Interceptor.promise = {resolve, reject};
  }

  static _open(method, url, ...args) {
    if (typeof method === 'string' && method.toLowerCase() === 'get' &&
        typeof url === 'string' && url.startsWith(Interceptor.urlPrefix) && url.includes('&include='))
      url = Interceptor._augment(url);
    return Interceptor.originalOpen.call(this, method, url, ...args);
  }

  static _augment(url) {
    const u = new URL(url);
    u.searchParams.set('include', u.searchParams.get('include') + ',mappings');
    u.searchParams.set('fields[mappings]', 'externalSite,externalId');
    url = u.href;
    this.addEventListener('load', Interceptor._onloadend);
    this.addEventListener('loadend', Interceptor._onloadend);
    return url;
  }

  static _onloadend(e) {
    const ok = e.type === 'load';
    const action = Interceptor.promise[ok ? 'resolve' : 'reject'];

    unsafeWindow.XMLHttpRequest.prototype.open = Interceptor.originalOpen;
    this.removeEventListener('load', Interceptor._onloadend);
    this.removeEventListener('loadend', Interceptor._onloadend);
    Interceptor.originalOpen = null;
    Interceptor.promise = null;

    action(ok ? JSON.parse(this.responseText) : e.target);
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
  const el = document.createElement(tag);
  const hasOwnProperty = Object.hasOwnProperty;
  for (const k in props) {
    if (!hasOwnProperty.call(props, k))
      continue;
    const v = props[k];
    switch (k) {
      case 'children':
        if (Symbol.iterator in v && typeof v !== 'string')
          el.append(...v);
        else
          el.append(v);
        break;
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
        el[k] = v;
    }
  }
  if (parent)
    parent.appendChild(el);
  if (before)
    before.insertAdjacentElement('beforebegin', el);
  if (after)
    after.insertAdjacentElement('aftereend', el);
  return el;
}

run();
