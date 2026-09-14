'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadFrontendFiles } = require('./frontend-env');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend', 'js');

function readFile(name){ return fs.readFileSync(path.join(FRONTEND_DIR, name), 'utf8'); }

// ---------- helpers ----------

function stubEl(){
  return {
    style: {},
    classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
    children: [],
    addEventListener(){},
    removeEventListener(){},
    setAttribute(){},
    getAttribute(){ return null; },
    querySelectorAll(){ return []; },
    appendChild(){},
  };
}

function makeDocStub(){
  const el = stubEl();
  return {
    querySelector(s){
      if(s === '#license-screen' || s === '#license-form' || s === '#license-key-input') return el;
      return null;
    },
    querySelectorAll(){ return []; },
    getElementById(){ return null; },
    createElement(){ return stubEl(); },
    addEventListener(){},
    removeEventListener(){},
    body: stubEl(),
    documentElement: { style: { setProperty(){} } },
    readyState: 'complete',
  };
}

function makeFakeIDB(){
  const stores = { kv: new Map(), pending: new Map(), pendingRecords: new Map(), encKey: new Map() };
  function tx(storeName){
    const map = stores[storeName] || (stores[storeName] = new Map());
    const txObj = { oncomplete: null, onerror: null };
    txObj.objectStore = () => {
      const fireComplete = () => queueMicrotask(()=>{ if(txObj.oncomplete) txObj.oncomplete(); });
      return {
        put(val, key){ map.set(key, val); fireComplete(); },
        get(key){
          const res = { result: map.get(key), onsuccess: null, onerror: null };
          queueMicrotask(()=>{ if(res.onsuccess) res.onsuccess(); });
          return res;
        },
        delete(key){ map.delete(key); fireComplete(); },
        getAll(){ return { result: [...map.values()] }; },
        clear(){ map.clear(); fireComplete(); },
      };
    };
    return txObj;
  }
  return {
    open(){
      const db = {
        objectStoreNames: { contains(n){ return n in stores; } },
        createObjectStore(n){ stores[n] = new Map(); },
        transaction(n){ return tx(n); },
        close(){},
        onversionchange: null,
      };
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onblocked: null, onerror: null };
      queueMicrotask(()=>{ if(req.onsuccess) req.onsuccess(); });
      return req;
    },
    stores,
  };
}

function makeCryptoStub(){
  return {
    subtle: {
      importKey(format, buf, algo, extractable, usages){
        return { _isKey: true, format, algoName: algo.name, extractable, usages, _bytes: Array.from(buf) };
      },
    },
    getRandomValues(arr){ return arr; },
  };
}

// ----------------------------------------------------------------
// Static guards: ensure no source file writes encKeyRaw to localStorage
// ----------------------------------------------------------------
describe('encKey hardening — static source guards', ()=>{
  const coreSrc    = readFile('core-utils.js');
  const appBootSrc = readFile('app-boot.js');
  const bootSrc    = readFile('boot.js');
  const permSrc    = readFile('permissions-sound.js');

  it('app-boot.js no longer writes encKeyRaw into LICENSE_CACHE_KEY', ()=>{
    // old pattern: JSON.stringify({ encKeyRaw, expiryDate: ... }) inside
    // localStorage.setItem(LICENSE_CACHE_KEY, ...). New pattern stores only metadata.
    assert.equal(appBootSrc.includes("JSON.stringify({\n      encKeyRaw,"), false,
      'encKeyRaw shorthand still present in LICENSE_CACHE_KEY JSON.stringify in app-boot.js');
    assert.equal(appBootSrc.includes('encKeyRaw:'), false,
      'encKeyRaw must not appear as a serialized property in app-boot.js');
  });

  it('boot.js no longer reads cached.encKeyRaw', ()=>{
    assert.equal(bootSrc.includes('cached.encKeyRaw'), false,
      'boot.js still references cached.encKeyRaw — must read CryptoKey from IndexedDB instead');
  });

  it('permissions-sound.js no longer writes encKeyRaw to LICENSE_CACHE_KEY', ()=>{
    assert.equal(permSrc.includes('encKeyRaw:'), false,
      'permissions-sound.js still writes encKeyRaw: into localStorage');
  });

  it('no file writes encKeyRaw into LICENSE_CACHE_KEY via localStorage', ()=>{
    const danger = /localStorage\.setItem\((?:LICENSE_CACHE_KEY|['"]appLicenseCacheV1['"]).{0,200}encKeyRaw/s;
    for(const [name, src] of [['core-utils.js', coreSrc], ['app-boot.js', appBootSrc], ['boot.js', bootSrc], ['permissions-sound.js', permSrc]]){
      assert.equal(danger.test(src), false, name + ' writes encKeyRaw to LICENSE_CACHE_KEY — security violation');
    }
  });
});

// ----------------------------------------------------------------
// Behavioral: core-utils IDB helpers
// ----------------------------------------------------------------
describe('encKey hardening — IDB helpers (core-utils)', ()=>{
  const fakeIDB    = makeFakeIDB();
  const cryptoStub = makeCryptoStub();
  const ctx        = loadFrontendFiles(['core-utils.js'], {
    indexedDB: fakeIDB,
    crypto:    cryptoStub,
  });

  const FAKE_KEY = { _isKey: true, _tag: 'test-key' };

  it('_persistEncryptionKey returns true and stores key in IDB', async ()=>{
    const ok = await ctx._persistEncryptionKey(FAKE_KEY);
    assert.equal(ok, true);
    assert.deepEqual(fakeIDB.stores.encKey.get('main'), FAKE_KEY);
  });

  it('_readStoredEncryptionKey retrieves the stored CryptoKey', async ()=>{
    const key = await ctx._readStoredEncryptionKey();
    assert.deepEqual(key, FAKE_KEY);
  });

  it('_clearStoredEncryptionKey removes the CryptoKey', async ()=>{
    await ctx._clearStoredEncryptionKey();
    const key = await ctx._readStoredEncryptionKey();
    assert.equal(key, null);
  });

  it('_migrateLegacyEncKeyRaw imports old raw key, persists to IDB, strips from localStorage', async ()=>{
    fakeIDB.stores.encKey.clear();
    ctx.localStorage.removeItem('appLicenseCacheV1');
    ctx.localStorage.setItem('appLicenseCacheV1', JSON.stringify({
      encKeyRaw:  'aGVsbG8=',   // base64("hello") — 5 bytes
      expiryDate: '2028-01-01T00:00:00.000Z',
      clientId:   'client-999',
      cachedAt:   '2025-01-01T00:00:00.000Z',
    }));

    const key = await ctx._migrateLegacyEncKeyRaw();
    assert.ok(key && key._isKey === true, 'must return a valid CryptoKey');
    assert.equal(key.extractable, false, 'CryptoKey must be non-extractable');
    assert.deepEqual(fakeIDB.stores.encKey.get('main'), key, 'IDB must contain the migrated key');

    const updated = JSON.parse(ctx.localStorage.getItem('appLicenseCacheV1'));
    assert.equal('encKeyRaw' in updated, false, 'encKeyRaw must be removed from localStorage');
    assert.equal(updated.expiryDate, '2028-01-01T00:00:00.000Z', 'expiryDate preserved');
    assert.equal(updated.clientId,   'client-999',                 'clientId preserved');
  });

  it('_migrateLegacyEncKeyRaw returns null when no cache exists', async ()=>{
    fakeIDB.stores.encKey.clear();
    ctx.localStorage.removeItem('appLicenseCacheV1');
    const result = await ctx._migrateLegacyEncKeyRaw();
    assert.equal(result, null);
    assert.equal(fakeIDB.stores.encKey.has('main'), false);
  });

  it('_migrateLegacyEncKeyRaw returns null when cache has no encKeyRaw', async ()=>{
    fakeIDB.stores.encKey.clear();
    ctx.localStorage.setItem('appLicenseCacheV1', JSON.stringify({
      expiryDate: '2028-01-01T00:00:00.000Z', clientId: 'c1',
    }));
    const result = await ctx._migrateLegacyEncKeyRaw();
    assert.equal(result, null);
  });
});

// ----------------------------------------------------------------
// Behavioral: activateAndStart (app-boot.js) — metadata only, no raw
// ----------------------------------------------------------------
describe('encKey hardening — activateAndStart (app-boot.js)', ()=>{
  const fakeIDB    = makeFakeIDB();
  const cryptoStub = makeCryptoStub();
  const docStub    = makeDocStub();
  const ctx        = loadFrontendFiles(['core-utils.js', 'app-boot.js'], {
    indexedDB: fakeIDB,
    crypto:    cryptoStub,
    document:  docStub,
    showToast(){},
  });
  // app-boot.js defines ensureServerLoginThenStart as a top-level function declaration, so it
  // replaces any sandbox stub — but function declarations are reassignable, so we swap it after
  // load to keep the test focused on api/token activation, not login flow internals.
  ctx.ensureServerLoginThenStart = async ()=>{};

  it('activateAndStart persists CryptoKey to IDB and writes only metadata to LICENSE_CACHE_KEY', async ()=>{
    fakeIDB.stores.encKey.clear();
    ctx.localStorage.removeItem('appLicenseCacheV1');

    await ctx.activateAndStart('aGVsbG8=', '2029-06-01T00:00:00.000Z', 'cli-77');

    const idbKey = fakeIDB.stores.encKey.get('main');
    assert.ok(idbKey && idbKey._isKey === true, 'CryptoKey must be stored in IDB');

    const cached = JSON.parse(ctx.localStorage.getItem('appLicenseCacheV1'));
    assert.ok(cached, 'LICENSE_CACHE_KEY must exist');
    assert.equal('encKeyRaw' in cached, false, 'encKeyRaw must NOT be present in LICENSE_CACHE_KEY');
    assert.equal(cached.expiryDate, '2029-06-01T00:00:00.000Z');
    assert.equal(cached.clientId,   'cli-77');
    assert.equal(typeof cached.cachedAt, 'string');

    // ENC_KEY is a top-level `let` (lexical binding), invisible as a context property, but
    // activateAndStart stores it directly into IDB — so a valid CryptoKey there proves ENC_KEY
    // was set to the imported key.
    assert.equal(idbKey.extractable, false, 'the key persisted to IDB must be non-extractable');
  });
});