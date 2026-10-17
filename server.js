// خادم الموقع: يقدّم الملفات الثابتة + واجهة API مشتركة بين كل الأجهزة.
// التخزين: MongoDB Atlas إذا ضبطت MONGODB_URI (موصى به)، وإلا ملف JSON محلي (للتجربة فقط، يُمسح على Render).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MIN_QUESTIONS = 10; // أقل عدد أسئلة للظهور في الترتيب
const IMPORT_PASSWORD = process.env.IMPORT_PASSWORD || "2580";
const PUBLIC = new Set(["index.html", "app.js", "style.css", "namozaj-asila.xlsx"]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const isInt = (v) => Number.isInteger(v);
const cleanStr = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const validDevice = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id);
const normKey = (q) => q.replace(/\s+/g, " ").trim().toLowerCase();
// مفتاح الاسم: يوحّد الاختلافات الإملائية الشائعة (أ/إ/آ، ى/ي، ة/ه، التشكيل، حالة الأحرف) حتى لا يتشابه اسمان عمليًا
const nameKey = (f, l) =>
  [f, l]
    .map((s) =>
      s.normalize("NFKC").toLowerCase()
        .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
        .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    )
    .join("|");
const HAS_SPACE = /[\s\u200B-\u200F\u2060\uFEFF]/;
const NAME_TAKEN = "هذا الاسم مستخدم من قبل شخص آخر. غيّر الاسم الأول أو اسم العائلة ليصبح مختلفًا.";
const userOut = (u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName });

// ---------------- التخزين ----------------
class MongoStore {
  async init() {
    const { MongoClient } = require("mongodb");
    this.client = new MongoClient(process.env.MONGODB_URI);
    await this.client.connect();
    const db = this.client.db(process.env.MONGODB_DB || "quizsite");
    this.q = db.collection("questions");
    this.u = db.collection("users");
    this.r = db.collection("results");
    await this.q.createIndex({ key: 1 }, { unique: true });
    await this.u.createIndex({ deviceId: 1 }, { unique: true });
    await this.u.createIndex({ nameKey: 1 }, { unique: true, partialFilterExpression: { nameKey: { $type: "string" } } });
    await this.r.createIndex({ userId: 1 });
    this.s = db.collection("seen");
    await this.s.createIndex({ userId: 1, qid: 1 }, { unique: true });
  }
  async seenIds(userId) { return (await this.s.find({ userId }, { projection: { _id: 0, qid: 1 } }).toArray()).map((x) => x.qid); }
  async markSeen(userId, qid) { await this.s.updateOne({ userId, qid }, { $setOnInsert: { userId, qid, at: Date.now() } }, { upsert: true }); }
  async resetSeen(userId) { await this.s.deleteMany({ userId }); }
  getUserByDevice(d) { return this.u.findOne({ deviceId: d }, { projection: { _id: 0 } }); }
  async addUserIfAbsent(user) {
    try {
      await this.u.updateOne({ deviceId: user.deviceId }, { $setOnInsert: user }, { upsert: true });
    } catch (e) {
      if (e && e.code === 11000) throw new HttpError(409, NAME_TAKEN);
      throw e;
    }
    return this.getUserByDevice(user.deviceId);
  }
  allUsers() { return this.u.find({}, { projection: { _id: 0 } }).toArray(); }
  countQuestions() { return this.q.countDocuments(); }
  allQuestions() { return this.q.find({}, { projection: { _id: 0 } }).toArray(); }
  async addQuestions(list) {
    let inserted = 0;
    try {
      const res = await this.q.insertMany(
        list.map((x) => ({ ...x, id: crypto.randomUUID() })),
        { ordered: false }
      );
      inserted = res.insertedCount;
    } catch (e) {
      if (e.result && typeof e.result.insertedCount === "number") inserted = e.result.insertedCount;
      else if (typeof e.insertedCount === "number") inserted = e.insertedCount;
      else throw e;
    }
    return { inserted, duplicates: list.length - inserted };
  }
  async addResult(r) { await this.r.insertOne({ ...r }); }
  allResults() { return this.r.find({}, { projection: { _id: 0 } }).toArray(); }
}

class FileStore {
  async init() {
    this.file = process.env.DATA_FILE || path.join(ROOT, "data.json");
    try { this.d = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { this.d = {}; }
    this.d.questions = this.d.questions || [];
    this.d.users = this.d.users || [];
    this.d.results = this.d.results || [];
    this.d.seen = this.d.seen || {};
    console.warn("تحذير: لا يوجد MONGODB_URI، يتم الحفظ في ملف محلي وقد يُمسح عند إعادة تشغيل الخادم.");
  }
  async seenIds(userId) { return this.d.seen[userId] || []; }
  async markSeen(userId, qid) {
    const a = (this.d.seen[userId] = this.d.seen[userId] || []);
    if (!a.includes(qid)) { a.push(qid); this._save(); }
  }
  async resetSeen(userId) { delete this.d.seen[userId]; this._save(); }
  _save() { fs.writeFileSync(this.file, JSON.stringify(this.d)); }
  async getUserByDevice(d) { return this.d.users.find((u) => u.deviceId === d) || null; }
  async addUserIfAbsent(user) {
    const ex = this.d.users.find((u) => u.deviceId === user.deviceId);
    if (ex) return ex;
    if (this.d.users.some((u) => (u.nameKey || nameKey(u.firstName, u.lastName)) === user.nameKey)) throw new HttpError(409, NAME_TAKEN);
    this.d.users.push(user); this._save(); return user;
  }
  async allUsers() { return this.d.users; }
  async countQuestions() { return this.d.questions.length; }
  async allQuestions() { return this.d.questions.slice(); }
  async addQuestions(list) {
    const seen = new Set(this.d.questions.map((q) => q.key));
    let inserted = 0, duplicates = 0;
    for (const q of list) {
      if (seen.has(q.key)) { duplicates++; continue; }
      seen.add(q.key);
      this.d.questions.push({ ...q, id: crypto.randomUUID() });
      inserted++;
    }
    if (inserted) this._save();
    return { inserted, duplicates };
  }
  async addResult(r) { this.d.results.push(r); this._save(); }
  async allResults() { return this.d.results; }
}

let store;

// ---------------- المسارات ----------------
async function handle(route, params, method, body) {
  const db = store;

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
      throw new HttpError(400, "اكتب الاسم الأول واسم العائلة (حرفان على الأقل لكل واحد)");
    if (HAS_SPACE.test(firstName) || HAS_SPACE.test(lastName))
      throw new HttpError(400, "يجب أن يكون الاسم الأول كلمة واحدة واسم العائلة كلمة واحدة، بدون مسافات");
    const existingSelf = await db.getUserByDevice(body.deviceId);
    if (existingSelf) return { user: userOut(existingSelf) };
    const key = nameKey(firstName, lastName);
    const taken = (await db.allUsers()).some((u) => (u.nameKey || nameKey(u.firstName, u.lastName)) === key);
    if (taken) throw new HttpError(409, NAME_TAKEN);
    const user = await db.addUserIfAbsent({
      id: crypto.randomUUID(), deviceId: body.deviceId, firstName, lastName, nameKey: key, createdAt: Date.now(),
    });
    return { user: userOut(user) };
  }

  if (route === "/count" && method === "GET") {
    const total = await db.countQuestions();
    let unseen = total;
    const deviceId = params.get("deviceId");
    if (validDevice(deviceId)) {
      const user = await db.getUserByDevice(deviceId);
      if (user) {
        const ids = new Set((await db.allQuestions()).map((q) => String(q.id)));
        const seen = (await db.seenIds(user.id)).filter((id) => ids.has(String(id)));
        unseen = total - seen.length;
      }
    }
    return { total, unseen };
  }

  // تسجيل أن المستخدم رأى سؤالًا (لا يتكرر عليه حتى ينهي كل الأسئلة)
  if (route === "/seen" && method === "POST") {
    if (!validDevice(body.deviceId)) throw new HttpError(400, "معرّف الجهاز غير صالح");
    const user = await db.getUserByDevice(body.deviceId);
    if (!user) throw new HttpError(404, "المستخدم غير مسجّل");
    const qid = String(body.id || "");
    if (!qid || qid.length > 64) throw new HttpError(400, "معرّف السؤال غير صالح");
    await db.markSeen(user.id, qid);
    return { ok: true };
  }

  if (route === "/quiz" && method === "GET") {
    const all = await db.allQuestions();
    let count = parseInt(params.get("count"), 10);
    if (!isInt(count) || count < 1) throw new HttpError(400, "عدد الأسئلة غير صالح");
    count = Math.min(count, all.length);
    if (count === 0) throw new HttpError(404, "لا توجد أسئلة في قاعدة البيانات بعد");
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    // الأسئلة التي لم يرها هذا المستخدم بعد تأتي أولًا؛ لا تُكرَّر عليه حتى ينتهي من كل الأسئلة
    let unseen = all;
    let reset = false;
    const deviceId = params.get("deviceId");
    const user = validDevice(deviceId) ? await db.getUserByDevice(deviceId) : null;
    if (user) {
      let seen = new Set((await db.seenIds(user.id)).map(String));
      unseen = all.filter((q) => !seen.has(String(q.id)));
      if (unseen.length === 0) {
        await db.resetSeen(user.id); // أنهى كل الأسئلة: نبدأ دورة جديدة
        unseen = all;
        reset = true;
      }
    }
    shuffle(unseen);
    let picked = unseen.slice(0, count);
    if (picked.length < count) {
      // الجديد لا يكفي العدد المطلوب: نكمّل بأسئلة سبق أن رآها (تكرار مقبول لأن الأسئلة انتهت)
      const have = new Set(picked.map((q) => String(q.id)));
      picked = picked.concat(shuffle(all.filter((q) => !have.has(String(q.id)))).slice(0, count - picked.length));
    }
    shuffle(picked);
    return {
      questions: picked.map((d) => ({ id: String(d.id), q: d.q, options: d.options, correct: d.correct })),
      fresh: Math.min(unseen.length, count),
      newRound: reset,
    };
  }

  if (route === "/import" && method === "POST") {
    if (String(body.password ?? "") !== IMPORT_PASSWORD) throw new HttpError(403, "كلمة المرور غير صحيحة");
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0 || rows.length > 1000) throw new HttpError(400, "حجم الدفعة غير صالح");
    const docs = [];
    const keys = new Set();
    let invalid = 0, dupInBatch = 0;
    for (const r of rows) {
      const q = cleanStr(r && r.q, 2000);
      const options = Array.isArray(r && r.o) ? r.o.map((x) => cleanStr(x, 1000)) : [];
      const correct = r && r.c;
      if (!q || options.length !== 5 || options.some((x) => !x) || !isInt(correct) || correct < 1 || correct > 5) { invalid++; continue; }
      const key = normKey(q);
      if (keys.has(key)) { dupInBatch++; continue; }
      keys.add(key);
      docs.push({ key, q, options, correct, createdAt: Date.now() });
    }
    let inserted = 0, duplicates = dupInBatch;
    if (docs.length) {
      const res = await db.addQuestions(docs);
      inserted = res.inserted;
      duplicates += res.duplicates;
    }
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
      userId: user.id, requested, answered, correct, wrong: answered - correct,
      totalTimeMs, finishedEarly: !!finishedEarly, createdAt: Date.now(),
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
      a.sessions++; a.total += r.answered; a.correct += r.correct; a.timeMs += r.totalTimeMs;
    }
    // نظام التقييم: 85 نقطة للدقة الموثوقة (حد ويلسون الأدنى بثقة 95%) + 15 نقطة للسرعة مضروبة في الدقة.
    // لا يُرتَّب إلا من أجاب MIN_QUESTIONS سؤالًا على الأقل.
    const Z = 1.96;
    const wilson = (c, n) => {
      if (!n) return 0;
      const p = c / n;
      const d = 1 + (Z * Z) / n;
      const centre = p + (Z * Z) / (2 * n);
      const margin = Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n));
      return Math.max(0, (centre - margin) / d);
    };
    const all = [...agg.values()].map((r) => {
      const acc = r.total ? r.correct / r.total : 0;
      const avgMs = r.total ? r.timeMs / r.total : 0;
      // السرعة: 5 ثوانٍ أو أقل = كاملة، 60 ثانية أو أكثر = صفر
      const speed = Math.min(1, Math.max(0, (60000 - avgMs) / 55000));
      const score = 85 * wilson(r.correct, r.total) + 15 * speed * acc;
      return {
        userId: r.userId, name: r.name, sessions: r.sessions, total: r.total, correct: r.correct,
        wrong: r.total - r.correct,
        accuracy: Math.round(acc * 1000) / 10,
        avgMs: Math.round(avgMs),
        score: Math.round(score * 10) / 10,
        _s: score,
      };
    });
    const ranked = all
      .filter((r) => r.total >= MIN_QUESTIONS)
      .sort((a, b) => b._s - a._s || b.correct - a.correct || a.avgMs - b.avgMs || a.name.localeCompare(b.name));
    // تعادل حقيقي في كل المعايير = نفس المركز
    let prev = null;
    ranked.forEach((r, i) => {
      r.rank = prev && prev.score === r.score && prev.correct === r.correct && prev.avgMs === r.avgMs ? prev.rank : i + 1;
      prev = r;
    });
    const pending = all.filter((r) => r.total < MIN_QUESTIONS).sort((a, b) => b.total - a.total);
    const list = ranked.slice(0, 100).concat(pending.slice(0, 50)).map((r) => { delete r._s; return r; });
    return { list, minQuestions: MIN_QUESTIONS };
  }

  throw new HttpError(404, "المسار غير موجود");
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 5e6) { reject(new HttpError(413, "الطلب كبير جدًا")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new HttpError(400, "JSON غير صالح")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const pathname = decodeURIComponent(u.pathname);

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    return res.end("ok");
  }

  if (pathname.startsWith("/api/")) {
    try {
      const body = req.method === "POST" ? await readBody(req) : null;
      const out = await handle(pathname.slice(4), u.searchParams, req.method, body);
      return sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error(e);
      return sendJson(res, 500, { error: "خطأ في الخادم" });
    }
  }

  const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!PUBLIC.has(name)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("غير موجود");
  }
  fs.readFile(path.join(ROOT, name), (err, data) => {
    if (err) { res.writeHead(500); return res.end("خطأ"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(name)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
});

(async () => {
  store = process.env.MONGODB_URI ? new MongoStore() : new FileStore();
  await store.init();
  server.listen(PORT, "0.0.0.0", () => console.log("Listening on " + PORT));
})().catch((e) => { console.error("فشل بدء الخادم:", e); process.exit(1); });
