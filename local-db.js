/* Data layer: shared Supabase database (see config.js), with localStorage fallback. */
const COLLECTIONS = {
  TEACHERS: "teachers",
  STUDENTS: "students",
  EXAMS: "exams",
  QUESTIONS: "questions",
  ANSWER_KEYS: "answerKeys",
  ATTEMPTS: "attempts",
  ANSWERS: "answers",
  VIOLATIONS: "violations",
};

const LOCAL_DB_KEY = "english_exam_system_v1";

function _clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(_clone);
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach(k => out[k] = _clone(value[k]));
    return out;
  }
  return value;
}
function _loadStore() {
  try {
    const raw = localStorage.getItem(LOCAL_DB_KEY);
    if (!raw) return {};
    return JSON.parse(raw, (k, v) => {
      if (v && typeof v === "object" && v.__date) return new Date(v.__date);
      return v;
    });
  } catch { return {}; }
}
function _saveStore(store) {
  localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(store, (k, v) => {
    if (v instanceof Date) return { __date: v.toISOString() };
    return v;
  }));
}
function _collection(store, name) {
  if (!store[name]) store[name] = {};
  return store[name];
}
function _resolve(v) {
  if (typeof v === "function") return v();
  return v;
}
function _applyData(data) {
  const out = _clone(data || {});
  Object.keys(out).forEach(k => { out[k] = _resolve(out[k]); });
  return out;
}


/* ---------- Storage backends ----------
   - Shared (Supabase): used when SUPABASE_URL and SUPABASE_ANON_KEY are set in config.js.
     Data is shared between ALL devices.
   - Local (localStorage): fallback only; data stays on this device/browser. */
const _dateReplacer = (k, v) => (v instanceof Date ? { __date: v.toISOString() } : v);
const _dateReviver = (k, v) => (v && typeof v === "object" && v.__date ? new Date(v.__date) : v);
// Serialise/parse so Date objects survive the round-trip to the server.
const _encode = obj => JSON.parse(JSON.stringify(obj, _dateReplacer));
const _decode = obj => JSON.parse(JSON.stringify(obj), _dateReviver);

const _localBackend = {
  shared: false,
  async getCollection(name) { return _collection(_loadStore(), name); },
  async getDoc(name, id) { const d = _collection(_loadStore(), name)[id]; return d ? _clone(d) : undefined; },
  async putDoc(name, id, data) { const s = _loadStore(); _collection(s, name)[id] = data; _saveStore(s); },
  async deleteDoc(name, id) { const s = _loadStore(); delete _collection(s, name)[id]; _saveStore(s); },
};

const _remoteBackend = {
  shared: true,
  _base() { return String(window.SUPABASE_URL).replace(/\/+$/, "") + "/rest/v1/docs"; },
  _headers(extra) {
    return { apikey: window.SUPABASE_ANON_KEY, Authorization: "Bearer " + window.SUPABASE_ANON_KEY, "Content-Type": "application/json", ...(extra || {}) };
  },
  async _req(url, opts) {
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { throw { code: "network", message: "تعذر الاتصال بالخادم. تأكد من الإنترنت." }; }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw { code: "db-" + res.status, message: "خطأ في قاعدة البيانات (" + res.status + "): " + t };
    }
    const txt = await res.text();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch { return null; }
  },
  async getCollection(name) {
    const rows = await this._req(this._base() + "?collection=eq." + encodeURIComponent(name) + "&select=id,data&limit=100000", { headers: this._headers() });
    const out = {};
    (rows || []).forEach(r => { out[r.id] = _decode(r.data); });
    return out;
  },
  async getDoc(name, id) {
    const rows = await this._req(this._base() + "?collection=eq." + encodeURIComponent(name) + "&id=eq." + encodeURIComponent(id) + "&select=data", { headers: this._headers() });
    return rows && rows[0] ? _decode(rows[0].data) : undefined;
  },
  async putDoc(name, id, data) {
    await this._req(this._base() + "?on_conflict=collection,id", {
      method: "POST",
      headers: this._headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ collection: name, id, data: _encode(data) }),
    });
  },
  async deleteDoc(name, id) {
    await this._req(this._base() + "?collection=eq." + encodeURIComponent(name) + "&id=eq." + encodeURIComponent(id), { method: "DELETE", headers: this._headers() });
  },
};


function _useRtdbEarly() { return !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.databaseURL); }
const _firebaseBackend = {
  shared: true,
  _dbPromise: null,
  _load(src) {
    return new Promise((res, rej) => {
      if (document.querySelector('script[data-fb="' + src + '"]')) return res();
      const el = document.createElement("script");
      el.src = src; el.dataset.fb = src; el.onload = res;
      el.onerror = () => rej({ code: "network", message: "تعذر تحميل Firebase. تأكد من الإنترنت." });
      document.head.appendChild(el);
    });
  },
  _db() {
    if (!this._dbPromise) {
      const base = "https://www.gstatic.com/firebasejs/10.12.2/";
      this._dbPromise = (async () => {
        await this._load(base + "firebase-app-compat.js");
        await this._load(base + "firebase-firestore-compat.js");
        if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
        return firebase.firestore();
      })();
      this._dbPromise.catch(() => { this._dbPromise = null; });
    }
    return this._dbPromise;
  },
  // Each document is stored as {json: "<serialised data>"} so any structure/date survives.
  async getCollection(name) {
    const snap = await (await this._db()).collection(name).get();
    const out = {};
    snap.forEach(d => { out[d.id] = _decode(JSON.parse(d.data().json)); });
    return out;
  },
  async getDoc(name, id) {
    const d = await (await this._db()).collection(name).doc(id).get();
    return d.exists ? _decode(JSON.parse(d.data().json)) : undefined;
  },
  async putDoc(name, id, data) {
    await (await this._db()).collection(name).doc(id).set({ json: JSON.stringify(_encode(data)) });
  },
  async deleteDoc(name, id) {
    await (await this._db()).collection(name).doc(id).delete();
  },
};

const _useFirebase = !_useRtdbEarly() && !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && window.FIREBASE_CONFIG.projectId);

/* Firebase Realtime Database via its REST API (no SDK needed). Each doc is stored as a JSON string. */
const _rtdbBackend = {
  shared: true,
  _url(path) { return String(window.FIREBASE_CONFIG.databaseURL).replace(/\/+$/, "") + "/" + path + ".json"; },
  async _req(path, opts) {
    let res;
    try { res = await fetch(this._url(path), opts); }
    catch (e) { throw { code: "network", message: "تعذر الاتصال بالخادم. تأكد من الإنترنت." }; }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw { code: "db-" + res.status, message: "خطأ في قاعدة البيانات (" + res.status + "). تأكد من قواعد Realtime Database: " + t };
    }
    return res.json().catch(() => null);
  },
  async getCollection(name) {
    const raw = (await this._req(encodeURIComponent(name))) || {};
    const out = {};
    Object.keys(raw).forEach(id => { try { out[id] = _decode(JSON.parse(raw[id])); } catch {} });
    return out;
  },
  async getDoc(name, id) {
    const raw = await this._req(encodeURIComponent(name) + "/" + encodeURIComponent(id));
    return raw ? _decode(JSON.parse(raw)) : undefined;
  },
  async putDoc(name, id, data) {
    await this._req(encodeURIComponent(name) + "/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(JSON.stringify(_encode(data))) });
  },
  async deleteDoc(name, id) {
    await this._req(encodeURIComponent(name) + "/" + encodeURIComponent(id), { method: "DELETE" });
  },
};
const _useRtdb = !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.databaseURL);

const _useRemote = !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY);
const _backend = _useRtdb ? _rtdbBackend : _useFirebase ? _firebaseBackend : (_useRemote ? _remoteBackend : _localBackend);
if (!_useRemote && !_useFirebase && !_useRtdb) console.warn("[exam-system] config.js غير مضبوط: البيانات محفوظة على هذا الجهاز فقط.");

class LocalDocSnapshot {
  constructor(id, data, ref) { this.id = id; this._data = data; this.exists = !!data; this.ref = ref; }
  data() { return this.exists ? _clone(this._data) : undefined; }
}
class LocalDocRef {
  constructor(name, id) { this.name = name; this.id = id; }
  async get() {
    return new LocalDocSnapshot(this.id, await _backend.getDoc(this.name, this.id), this);
  }
  async set(data, options = {}) {
    const next = _applyData(data);
    if (options.merge) {
      const cur = (await _backend.getDoc(this.name, this.id)) || {};
      await _backend.putDoc(this.name, this.id, { ...cur, ...next });
    } else {
      await _backend.putDoc(this.name, this.id, next);
    }
    return this;
  }
  async update(data) {
    const cur = await _backend.getDoc(this.name, this.id);
    if (!cur) throw { code: "not-found", message: "المستند غير موجود." };
    const next = _applyData(data);
    Object.keys(next).forEach(k => { if (next[k] && next[k].__localIncrement) next[k] = (Number(cur[k]) || 0) + next[k].__localIncrement; });
    await _backend.putDoc(this.name, this.id, { ...cur, ...next });
    return this;
  }
  async delete() {
    await _backend.deleteDoc(this.name, this.id);
    return this;
  }
}
class LocalQuery {
  constructor(name, filters = [], order = null, limitN = null) { this.name=name; this.filters=filters; this.order=order; this.limitN=limitN; }
  where(field, op, value) { return new LocalQuery(this.name, [...this.filters, {field, op, value}], this.order, this.limitN); }
  orderBy(field, direction = "asc") { return new LocalQuery(this.name, this.filters, {field, direction}, this.limitN); }
  limit(n) { return new LocalQuery(this.name, this.filters, this.order, n); }
  async get() {
    let rows = Object.entries(await _backend.getCollection(this.name)).map(([id, data]) => ({id, data}));
    rows = rows.filter(row => this.filters.every(f => {
      const actual = row.data[f.field];
      if (f.op === "==") return actual === f.value;
      if (f.op === "!=") return actual !== f.value;
      if (f.op === ">") return actual > f.value;
      if (f.op === ">=") return actual >= f.value;
      if (f.op === "<") return actual < f.value;
      if (f.op === "<=") return actual <= f.value;
      if (f.op === "array-contains") return Array.isArray(actual) && actual.includes(f.value);
      return false;
    }));
    if (this.order) {
      const {field, direction} = this.order;
      rows.sort((a,b) => {
        const av=a.data[field], bv=b.data[field];
        const ax=av instanceof Date ? av.getTime() : av, bx=bv instanceof Date ? bv.getTime() : bv;
        if (ax === bx) return 0;
        const cmp = ax < bx ? -1 : 1;
        return direction === "desc" ? -cmp : cmp;
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    const docs = rows.map(r => new LocalDocSnapshot(r.id, r.data, new LocalDocRef(this.name, r.id)));
    return { docs, empty: docs.length === 0, size: docs.length, forEach(fn){ docs.forEach(fn); } };
  }
}
class LocalCollection {
  constructor(name) { this.name=name; }
  doc(id) { return new LocalDocRef(this.name, id || simpleId()); }
  add(data) { const ref=this.doc(); return ref.set(data).then(()=>ref); }
  where(field, op, value) { return new LocalQuery(this.name).where(field, op, value); }
  orderBy(field, direction) { return new LocalQuery(this.name).orderBy(field, direction); }
  limit(n) { return new LocalQuery(this.name).limit(n); }
}
class LocalBatch {
  constructor(){ this.ops=[]; }
  set(ref,data,options){ this.ops.push(()=>ref.set(data,options)); return this; }
  update(ref,data){ this.ops.push(()=>ref.update(data)); return this; }
  delete(ref){ this.ops.push(()=>ref.delete()); return this; }
  async commit(){ for(const op of this.ops) await op(); }
}
const db = {
  collection(name){ return new LocalCollection(name); },
  batch(){ return new LocalBatch(); }
};

function localIncrement(n) { return { __localIncrement: Number(n) || 0 }; }
