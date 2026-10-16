/*
 * قاعدة بيانات محلية بالكامل (داخل المتصفح) بدلاً من MongoDB.
 * - التخزين الأساسي: IndexedDB (يتسع لآلاف الأسئلة).
 * - إن لم يتوفر IndexedDB (بعض أوضاع التصفح الخاص) نستخدم localStorage كبديل.
 * - لا يوجد أي اتصال بالشبكة ولا خادم.
 * تعرض الدالة LocalAPI.request(path, body) نفس مسارات الـ API القديمة
 * (/me, /register, /count, /quiz, /import, /result, /leaderboard) حتى لا تتغير واجهة الموقع.
 */
(function () {
  "use strict";

  const DB_NAME = "quizsite-local";
  const DB_VERSION = 1;
  const IMPORT_PASSWORD = "2580"; // كلمة مرور إضافة الأسئلة (غيّرها من هنا)
  const LS_PREFIX = "quizsite:";

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // ---------- أدوات ----------
  const isInt = (v) => Number.isInteger(v);
  const cleanStr = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const validDevice = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id);
  const normKey = (q) => q.replace(/\s+/g, " ").trim().toLowerCase();
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "u" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  const userOut = (u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName });

  // =====================================================================
  //  الخلفية الأولى: IndexedDB
  // =====================================================================
  class IdbBackend {
    constructor(db) {
      this.db = db;
    }

    static open() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error("no indexedDB"));
        let req;
        try {
          req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
          return reject(e);
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          const qs = db.createObjectStore("questions", { keyPath: "id", autoIncrement: true });
          qs.createIndex("key", "key", { unique: true });
          const us = db.createObjectStore("users", { keyPath: "id" });
          us.createIndex("deviceId", "deviceId", { unique: true });
          const rs = db.createObjectStore("results", { keyPath: "id", autoIncrement: true });
          rs.createIndex("userId", "userId", { unique: false });
        };
        req.onsuccess = () => resolve(new IdbBackend(req.result));
        req.onerror = () => reject(req.error || new Error("idb open failed"));
        req.onblocked = () => reject(new Error("idb blocked"));
      });
    }

    _tx(stores, mode) {
      return this.db.transaction(stores, mode);
    }
    _wrap(req) {
      return new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    }
    _done(tx) {
      return new Promise((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error("transaction aborted"));
      });
    }

    async getUserByDevice(deviceId) {
      const tx = this._tx(["users"], "readonly");
      const r = await this._wrap(tx.objectStore("users").index("deviceId").get(deviceId));
      return r || null;
    }
    async addUserIfAbsent(user) {
      const tx = this._tx(["users"], "readwrite");
      const store = tx.objectStore("users");
      const existing = await this._wrap(store.index("deviceId").get(user.deviceId));
      if (!existing) store.add(user);
      await this._done(tx);
      return existing || user;
    }
    async allUsers() {
      return this._wrap(this._tx(["users"], "readonly").objectStore("users").getAll());
    }
    async countQuestions() {
      return this._wrap(this._tx(["questions"], "readonly").objectStore("questions").count());
    }
    async allQuestions() {
      return this._wrap(this._tx(["questions"], "readonly").objectStore("questions").getAll());
    }
    async addQuestions(list) {
      const tx = this._tx(["questions"], "readwrite");
      const store = tx.objectStore("questions");
      let inserted = 0;
      let duplicates = 0;
      await new Promise((resolve, reject) => {
        let pending = list.length;
        if (!pending) return resolve();
        for (const q of list) {
          const req = store.add(q);
          req.onsuccess = () => {
            inserted++;
            if (--pending === 0) resolve();
          };
          req.onerror = (ev) => {
            if (req.error && req.error.name === "ConstraintError") {
              ev.preventDefault(); // سؤال مكرر: نتجاهله ولا نُلغي العملية كلها
              ev.stopPropagation();
              duplicates++;
              if (--pending === 0) resolve();
            } else {
              reject(req.error);
            }
          };
        }
      });
      await this._done(tx);
      return { inserted, duplicates };
    }
    async addResult(r) {
      const tx = this._tx(["results"], "readwrite");
      tx.objectStore("results").add(r);
      await this._done(tx);
    }
    async allResults() {
      return this._wrap(this._tx(["results"], "readonly").objectStore("results").getAll());
    }
  }

  // =====================================================================
  //  الخلفية الثانية (احتياطية): localStorage
  // =====================================================================
  class LsBackend {
    _read(name) {
      try {
        return JSON.parse(localStorage.getItem(LS_PREFIX + name) || "[]");
      } catch (e) {
        return [];
      }
    }
    _write(name, arr) {
      try {
        localStorage.setItem(LS_PREFIX + name, JSON.stringify(arr));
      } catch (e) {
        throw new HttpError(500, "تعذّر الحفظ: مساحة التخزين في المتصفح ممتلئة أو غير متاحة");
      }
    }
    async getUserByDevice(deviceId) {
      return this._read("users").find((u) => u.deviceId === deviceId) || null;
    }
    async addUserIfAbsent(user) {
      const users = this._read("users");
      const existing = users.find((u) => u.deviceId === user.deviceId);
      if (existing) return existing;
      users.push(user);
      this._write("users", users);
      return user;
    }
    async allUsers() {
      return this._read("users");
    }
    async countQuestions() {
      return this._read("questions").length;
    }
    async allQuestions() {
      return this._read("questions");
    }
    async addQuestions(list) {
      const qs = this._read("questions");
      const seen = new Set(qs.map((q) => q.key));
      let nextId = qs.reduce((m, q) => Math.max(m, q.id || 0), 0) + 1;
      let inserted = 0;
      let duplicates = 0;
      for (const q of list) {
        if (seen.has(q.key)) {
          duplicates++;
          continue;
        }
        seen.add(q.key);
        qs.push(Object.assign({ id: nextId++ }, q));
        inserted++;
      }
      if (inserted) this._write("questions", qs);
      return { inserted, duplicates };
    }
    async addResult(r) {
      const rs = this._read("results");
      rs.push(Object.assign({ id: rs.length + 1 }, r));
      this._write("results", rs);
    }
    async allResults() {
      return this._read("results");
    }
  }

  // ---------- فتح قاعدة البيانات (مرة واحدة) ----------
  let backendPromise = null;
  function getBackend() {
    if (!backendPromise) {
      backendPromise = IdbBackend.open()
        .catch(() => new LsBackend())
        .then(async (b) => {
          // نطلب من المتصفح عدم حذف البيانات تلقائيًا عند امتلاء المساحة
          try {
            if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
          } catch (e) {}
          return b;
        });
    }
    return backendPromise;
  }

  // =====================================================================
  //  المسارات (نفس منطق الخادم القديم)
  // =====================================================================
  async function handle(path, body) {
    const u = new URL(path, "http://local");
    const route = u.pathname;
    const params = u.searchParams;
    const method = body ? "POST" : "GET";
    const db = await getBackend();

    if (route === "/me" && method === "GET") {
      const deviceId = params.get("deviceId");
      if (!validDevice(deviceId)) throw new HttpError(400, "معرّف الجهاز غير صالح");
      const user = await db.getUserByDevice(deviceId);
      return { user: user ? userOut(user) : null };
    }

    if (route === "/register" && method === "POST") {
      if (!validDevice(body.deviceId)) throw new HttpError(400, "معرّف الجهاز غير صالح");
      const firstName = cleanStr(body.firstName, 30);
      const lastName = cleanStr(body.lastName, 30);
      if (firstName.length < 2 || lastName.length < 2)
        throw new HttpError(400, "اكتب الاسم الأول والأخير (حرفان على الأقل لكل واحد)");
      const user = await db.addUserIfAbsent({
        id: newId(),
        deviceId: body.deviceId,
        firstName,
        lastName,
        createdAt: Date.now(),
      });
      return { user: userOut(user) };
    }

    if (route === "/count" && method === "GET") {
      return { total: await db.countQuestions() };
    }

    if (route === "/quiz" && method === "GET") {
      const all = await db.allQuestions();
      let count = parseInt(params.get("count"), 10);
      if (!isInt(count) || count < 1) throw new HttpError(400, "عدد الأسئلة غير صالح");
      count = Math.min(count, all.length);
      if (count === 0) throw new HttpError(404, "لا توجد أسئلة في قاعدة البيانات بعد");
      // خلط عشوائي (Fisher–Yates) ثم أخذ العدد المطلوب
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      return {
        questions: all.slice(0, count).map((d) => ({ id: String(d.id), q: d.q, options: d.options, correct: d.correct })),
      };
    }

    if (route === "/import" && method === "POST") {
      if (String(body.password ?? "") !== IMPORT_PASSWORD) throw new HttpError(403, "كلمة المرور غير صحيحة");
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length === 0 || rows.length > 1000) throw new HttpError(400, "حجم الدفعة غير صالح");
      const docs = [];
      let invalid = 0;
      for (const r of rows) {
        const q = cleanStr(r && r.q, 2000);
        const options = Array.isArray(r && r.o) ? r.o.map((x) => cleanStr(x, 1000)) : [];
        const correct = r && r.c;
        if (!q || options.length !== 5 || options.some((x) => !x) || !isInt(correct) || correct < 1 || correct > 5) {
          invalid++;
          continue;
        }
        docs.push({ key: normKey(q), q, options, correct, createdAt: Date.now() });
      }
      let inserted = 0;
      let duplicates = 0;
      if (docs.length) ({ inserted, duplicates } = await db.addQuestions(docs));
      return { inserted, duplicates, invalid };
    }

    if (route === "/result" && method === "POST") {
      if (!validDevice(body.deviceId)) throw new HttpError(400, "معرّف الجهاز غير صالح");
      const user = await db.getUserByDevice(body.deviceId);
      if (!user) throw new HttpError(404, "المستخدم غير مسجّل");
      const { requested, answered, correct, totalTimeMs, finishedEarly } = body;
      if (![requested, answered, correct, totalTimeMs].every(isInt)) throw new HttpError(400, "بيانات النتيجة غير صالحة");
      if (answered < 1 || answered > 100000 || correct < 0 || correct > answered || totalTimeMs < 0 || totalTimeMs > 1e9 || requested < answered)
        throw new HttpError(400, "بيانات النتيجة غير منطقية");
      await db.addResult({
        userId: user.id,
        requested,
        answered,
        correct,
        wrong: answered - correct,
        totalTimeMs,
        finishedEarly: !!finishedEarly,
        createdAt: Date.now(),
      });
      return { ok: true };
    }

    if (route === "/leaderboard" && method === "GET") {
      const [users, results] = await Promise.all([db.allUsers(), db.allResults()]);
      const byId = new Map(users.map((x) => [x.id, x]));
      const agg = new Map();
      for (const r of results) {
        const usr = byId.get(r.userId);
        if (!usr) continue;
        let a = agg.get(r.userId);
        if (!a) agg.set(r.userId, (a = { userId: r.userId, name: usr.firstName + " " + usr.lastName, sessions: 0, total: 0, correct: 0, timeMs: 0 }));
        a.sessions++;
        a.total += r.answered;
        a.correct += r.correct;
        a.timeMs += r.totalTimeMs;
      }
      const list = [...agg.values()]
        .map((r) => ({
          userId: r.userId,
          name: r.name,
          sessions: r.sessions,
          total: r.total,
          correct: r.correct,
          wrong: r.total - r.correct,
          accuracy: r.total ? Math.round((r.correct / r.total) * 1000) / 10 : 0,
          avgMs: r.total ? Math.round(r.timeMs / r.total) : 0,
        }))
        .sort((a, b) => b.correct - a.correct || b.accuracy - a.accuracy)
        .slice(0, 100);
      return { list };
    }

    throw new HttpError(404, "المسار غير موجود");
  }

  window.LocalAPI = {
    async request(path, body) {
      try {
        return await handle(path, body);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error(e);
        const err = new Error("تعذّر الوصول إلى التخزين المحلي في المتصفح");
        err.status = 500;
        throw err;
      }
    },
  };
})();
