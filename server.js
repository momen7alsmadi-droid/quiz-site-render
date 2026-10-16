// خادم الموقع: يقدّم الملفات الثابتة + واجهة API مشتركة بين كل الأجهزة.
// التخزين: MongoDB Atlas إذا ضبطت MONGODB_URI (موصى به)، وإلا ملف JSON محلي (للتجربة فقط، يُمسح على Render).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
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
    await this.r.createIndex({ userId: 1 });
  }
  getUserByDevice(d) { return this.u.findOne({ deviceId: d }, { projection: { _id: 0 } }); }
  async addUserIfAbsent(user) {
    await this.u.updateOne({ deviceId: user.deviceId }, { $setOnInsert: user }, { upsert: true });
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
    console.warn("تحذير: لا يوجد MONGODB_URI، يتم الحفظ في ملف محلي وقد يُمسح عند إعادة تشغيل الخادم.");
  }
  _save() { fs.writeFileSync(this.file, JSON.stringify(this.d)); }
  async getUserByDevice(d) { return this.d.users.find((u) => u.deviceId === d) || null; }
  async addUserIfAbsent(user) {
    const ex = this.d.users.find((u) => u.deviceId === user.deviceId);
    if (ex) return ex;
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
      throw new HttpError(400, "اكتب الاسم الأول والأخير (حرفان على الأقل لكل واحد)");
    const user = await db.addUserIfAbsent({
      id: crypto.randomUUID(), deviceId: body.deviceId, firstName, lastName, createdAt: Date.now(),
    });
    return { user: userOut(user) };
  }

  if (route === "/count" && method === "GET") return { total: await db.countQuestions() };

  if (route === "/quiz" && method === "GET") {
    const all = await db.allQuestions();
    let count = parseInt(params.get("count"), 10);
    if (!isInt(count) || count < 1) throw new HttpError(400, "عدد الأسئلة غير صالح");
    count = Math.min(count, all.length);
    if (count === 0) throw new HttpError(404, "لا توجد أسئلة في قاعدة البيانات بعد");
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return { questions: all.slice(0, count).map((d) => ({ id: String(d.id), q: d.q, options: d.options, correct: d.correct })) };
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
    const list = [...agg.values()]
      .map((r) => ({
        userId: r.userId, name: r.name, sessions: r.sessions, total: r.total, correct: r.correct,
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
