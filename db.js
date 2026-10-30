/* Datová vrstva. Dva backendy se stejným rozhraním:
 *  - LocalDB  : IndexedDB v prohlížeči (offline, jen toto zařízení)
 *  - RemoteDB : Supabase (společná databáze pro kancl, mobily; živé aktualizace)
 * Tabulky: products, movements, orders, settings. Rozpracované doklady (drafts) jsou vždy lokální.
 */
const LocalDB = (() => {
  const NAME = 'imco-sklad';
  const VERSION = 2;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('products')) {
          const s = db.createObjectStore('products', { keyPath: 'id' });
          s.createIndex('code', 'code', { unique: true });
        }
        if (!db.objectStoreNames.contains('movements')) db.createObjectStore('movements', { keyPath: 'id' }).createIndex('ts', 'ts');
        if (!db.objectStoreNames.contains('orders')) db.createObjectStore('orders', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const reqToPromise = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  function tx(stores, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result; try { result = fn(t); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  return {
    name: 'local',
    async getAll(store) { const db = await open(); return reqToPromise(db.transaction(store).objectStore(store).getAll()); },
    async get(store, key) { const db = await open(); return reqToPromise(db.transaction(store).objectStore(store).get(key)); },
    put(store, obj) { return tx(store, 'readwrite', t => t.objectStore(store).put(obj)); },
    del(store, key) { return tx(store, 'readwrite', t => t.objectStore(store).delete(key)); },
    clear(store) { return tx(store, 'readwrite', t => t.objectStore(store).clear()); },
    applyMovement(movement, products) {
      return tx(['movements', 'products'], 'readwrite', t => { t.objectStore('movements').put(movement); products.forEach(p => t.objectStore('products').put(p)); });
    },
    async importAll(data, { replace }) {
      return tx(['products', 'movements', 'orders', 'settings'], 'readwrite', t => {
        if (replace) { t.objectStore('products').clear(); t.objectStore('movements').clear(); t.objectStore('orders').clear(); }
        (data.products || []).forEach(p => t.objectStore('products').put(p));
        (data.movements || []).forEach(m => t.objectStore('movements').put(m));
        (data.orders || []).forEach(o => t.objectStore('orders').put(o));
        (data.settings || []).forEach(s => t.objectStore('settings').put(s));
      });
    },
    subscribe() { return () => {}; }
  };
})();

/* Supabase: každá tabulka má sloupce (id text primary key, data jsonb, updated_at). Objekt se ukládá celý do `data`. */
function RemoteDB(client) {
  const KEY = { products: 'id', movements: 'id', orders: 'id', settings: 'key' };
  const rowToObj = (store, r) => store === 'settings' ? { key: r.id, value: r.data } : r.data;
  const objToRow = (store, o) => store === 'settings' ? { id: o.key, data: o.value } : { id: o.id, data: o };
  const fail = (r) => { if (r.error) throw new Error(r.error.message || String(r.error)); return r; };
  return {
    name: 'remote',
    async getAll(store) {
      if (store === 'drafts') return LocalDB.getAll(store);
      const out = []; let from = 0;
      while (true) {
        const r = fail(await client.from(store).select('id,data').range(from, from + 999));
        out.push(...r.data.map(x => rowToObj(store, x)));
        if (r.data.length < 1000) break; from += 1000;
      }
      return out;
    },
    async get(store, key) {
      if (store === 'drafts') return LocalDB.get(store, key);
      const r = fail(await client.from(store).select('id,data').eq('id', key).maybeSingle());
      return r.data ? rowToObj(store, r.data) : undefined;
    },
    async put(store, obj) {
      if (store === 'drafts') return LocalDB.put(store, obj);
      fail(await client.from(store).upsert(objToRow(store, obj)));
    },
    async del(store, key) {
      if (store === 'drafts') return LocalDB.del(store, key);
      fail(await client.from(store).delete().eq('id', key));
    },
    async clear(store) {
      if (store === 'drafts') return LocalDB.clear(store);
      fail(await client.from(store).delete().neq('id', ''));
    },
    async applyMovement(movement, products) {
      fail(await client.from('products').upsert(products.map(p => objToRow('products', p))));
      fail(await client.from('movements').upsert(objToRow('movements', movement)));
    },
    async importAll(data, { replace }) {
      if (replace) for (const s of ['products', 'movements', 'orders']) await this.clear(s);
      for (const [store, rows] of [['products', data.products], ['movements', data.movements], ['orders', data.orders], ['settings', data.settings]]) {
        if (!rows || !rows.length) continue;
        for (let i = 0; i < rows.length; i += 500) fail(await client.from(store).upsert(rows.slice(i, i + 500).map(o => objToRow(store, o))));
      }
    },
    /** Živé změny z ostatních zařízení. onChange(store, {id, data|null}) */
    subscribe(onChange) {
      const ch = client.channel('sklad-changes');
      ['products', 'movements', 'orders'].forEach(store => {
        ch.on('postgres_changes', { event: '*', schema: 'public', table: store }, (payload) => {
          const row = payload.new && payload.new.id ? payload.new : null;
          onChange(store, row ? { id: row.id, data: row.data } : { id: payload.old && payload.old.id, data: null });
        });
      });
      ch.subscribe();
      return () => client.removeChannel(ch);
    }
  };
}

/* Aktivní backend. Supabase konfigurace se čte z localStorage (nastaví se v Nastavení). */
const DB = (() => {
  let impl = LocalDB; let client = null;
  // Výchozí projekt (anon key je veřejný klíč aplikace; přístup k datům hlídá přihlášení + RLS v databázi).
  const DEFAULT_CONFIG = {
    url: 'https://kokplcmcsujomumflsey.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtva3BsY21jc3Vqb211bWZsc2V5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyOTg3MDAsImV4cCI6MjEwODg3NDcwMH0.JKSW_zUd2s4F1NIBcIKnx-I-jUsKDcpLABspQXEKQn0'
  };
  function config() {
    try { const raw = localStorage.getItem('supabase'); if (raw === 'off') return null; if (raw) return JSON.parse(raw); } catch (_) {}
    return DEFAULT_CONFIG;
  }
  function init() {
    const cfg = config();
    if (cfg && cfg.url && cfg.key && window.supabase) {
      client = window.supabase.createClient(cfg.url, cfg.key);
      impl = RemoteDB(client);
    } else { client = null; impl = LocalDB; }
    return impl.name;
  }
  init();
  const api = {
    get mode() { return impl.name; },
    get client() { return client; },
    config, init,
    setConfig(cfg) { try { localStorage.setItem('supabase', cfg ? JSON.stringify(cfg) : 'off'); } catch (_) {} init(); },
    getAll: (s) => impl.getAll(s), get: (s, k) => impl.get(s, k), put: (s, o) => impl.put(s, o), del: (s, k) => impl.del(s, k), clear: (s) => impl.clear(s),
    applyMovement: (m, p) => impl.applyMovement(m, p), importAll: (d, o) => impl.importAll(d, o), subscribe: (fn) => impl.subscribe(fn),
    local: LocalDB,
    async exportAll() {
      const [products, movements, orders, settings] = await Promise.all([impl.getAll('products'), impl.getAll('movements'), impl.getAll('orders'), impl.getAll('settings')]);
      return { app: 'imco-sklad', version: 2, exportedAt: new Date().toISOString(), products, movements, orders, settings };
    },
    /** Přihlášení (jen Supabase). */
    async session() { if (!client) return null; const { data } = await client.auth.getSession(); return data.session; },
    async signIn(email, password) { const { error } = await client.auth.signInWithPassword({ email, password }); if (error) throw new Error(error.message); },
    async signUp(email, password) { const { error } = await client.auth.signUp({ email, password }); if (error) throw new Error(error.message); },
    async signOut() { if (client) await client.auth.signOut(); },
    /** Zavolá Edge Function (např. AI rozpoznání objednávky). */
    async callFunction(name, body) {
      if (!client) throw new Error('Supabase není nastaveno');
      const { data, error } = await client.functions.invoke(name, { body });
      if (error) throw new Error(error.message || 'Chyba funkce ' + name);
      return data;
    }
  };
  return api;
})();
