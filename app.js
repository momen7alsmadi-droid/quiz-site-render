(function () {
  "use strict";

  const app = document.getElementById("app");
  const LETTERS = ["أ", "ب", "ج", "د", "هـ"];
  const PRESETS = [5, 10, 25, 50, 100, 250];
  const CHUNK = 500;

  let user = null;
  let timerHandle = null;
  let memId = null;

  // ---------- أدوات ----------
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (id) => document.getElementById(id);
  const nf = (n) => Number(n).toLocaleString("ar-EG");

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "d" + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  // معرّف عشوائي للمتصفح (يربط المستخدم ببياناته المحلية)
  function deviceId() {
    try {
      let id = localStorage.getItem("device_id");
      if (!id) {
        id = uuid();
        localStorage.setItem("device_id", id);
      }
      return id;
    } catch (e) {
      return memId || (memId = uuid());
    }
  }

  // كل البيانات تُحفظ على الخادم (مشتركة بين كل الأجهزة)
  async function api(path, body) {
    let res;
    try {
      res = await fetch("/api" + path, body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : { method: "GET" });
    } catch (e) {
      const err = new Error("تعذّر الاتصال بالخادم. تأكد من الإنترنت وحاول مرة أخرى (قد يحتاج الخادم نصف دقيقة ليستيقظ).");
      err.status = 0;
      throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error(data.error || "خطأ في الخادم");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function fmtTime(ms) {
    let s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    s = s % 60;
    const p = (x) => String(x).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }
  const fmtSec = (ms) => (ms / 1000).toFixed(1);

  function stopTimer() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
  }
  function show(html) {
    stopTimer();
    app.innerHTML = html;
    window.scrollTo(0, 0);
  }

  // ---------- البداية ----------
  async function init() {
    show('<p class="muted center">جارٍ التحميل…</p>');
    try {
      const r = await api("/me?deviceId=" + encodeURIComponent(deviceId()));
      user = r.user;
      user ? viewHome() : viewWelcome();
    } catch (e) {
      show(`<div class="card stack"><div class="err">${esc(e.message)}</div><button id="retry">إعادة المحاولة</button></div>`);
      $("retry").onclick = init;
    }
  }

  // ---------- إدخال الاسم ----------
  function viewWelcome(msg, prev) {
    prev = prev || { f: "", l: "" };
    show(`
      <h1>أهلاً بك</h1>
      <p class="muted">قبل أن نبدأ، عرّفنا باسمك: كلمة واحدة للاسم الأول وكلمة واحدة لاسم العائلة (بدون مسافات)، ولا يمكن أن يتطابق اسمك مع اسم مستخدم آخر.</p>
      <form id="f" class="card stack">
        <div><label for="fn">الاسم الأول</label><input id="fn" type="text" maxlength="30" autocomplete="given-name" value="${esc(prev.f)}"></div>
        <div><label for="ln">اسم العائلة</label><input id="ln" type="text" maxlength="30" autocomplete="family-name" value="${esc(prev.l)}"></div>
        ${msg ? `<div class="err">${esc(msg)}</div>` : ""}
        <button class="big" type="submit">متابعة</button>
      </form>`);
    for (const id of ["fn", "ln"]) {
      $(id).addEventListener("input", (ev) => {
        const c = ev.target.value.replace(/[\s\u200B-\u200F\u2060\uFEFF]/g, "");
        if (c !== ev.target.value) ev.target.value = c;
      });
    }
    $("f").onsubmit = async (e) => {
      e.preventDefault();
      const firstName = $("fn").value.trim();
      const lastName = $("ln").value.trim();
      if (firstName.length < 2 || lastName.length < 2) return viewWelcome("اكتب الاسم الأول واسم العائلة (حرفان على الأقل لكل واحد)", { f: firstName, l: lastName });
      if (/[\s\u200B-\u200F\u2060\uFEFF]/.test(firstName + lastName)) return viewWelcome("الاسم الأول كلمة واحدة واسم العائلة كلمة واحدة، بدون مسافات", { f: firstName, l: lastName });
      try {
        const r = await api("/register", { deviceId: deviceId(), firstName, lastName });
        user = r.user;
        viewHome();
      } catch (err) {
        viewWelcome(err.message, { f: firstName, l: lastName });
      }
    };
  }

  // ---------- الرئيسية ----------
  function viewHome() {
    show(`
      <h1>أهلاً يا ${esc(user.firstName)}</h1>
      <p class="muted">اختر ما تريد:</p>
      <div class="stack">
        <button class="big" id="start">بدء الأسئلة</button>
        <button class="big ghost" id="board">لوحة الصدارة</button>
      </div>
      <p class="center" style="margin-top:28px"><button class="link small" id="imp">إضافة أسئلة من ملف إكسل</button></p>`);
    $("start").onclick = viewSetup;
    $("board").onclick = viewBoard;
    $("imp").onclick = viewImport;
  }

  // ---------- اختيار عدد الأسئلة ----------
  async function viewSetup() {
    show('<p class="muted center">جارٍ التحميل…</p>');
    let total, unseen;
    try {
      const c = await api("/count?deviceId=" + encodeURIComponent(deviceId()));
      total = c.total;
      unseen = c.unseen;
    } catch (e) {
      show(`<div class="card stack"><div class="err">${esc(e.message)}</div><button id="b">رجوع</button></div>`);
      $("b").onclick = viewHome;
      return;
    }
    if (total === 0) {
      show(`<div class="card stack"><p>لا توجد أسئلة محفوظة حتى الآن. أضف أسئلة من ملف إكسل أولًا.</p><button id="b">رجوع</button></div>`);
      $("b").onclick = viewHome;
      return;
    }
    let count = Math.min(10, total);
    const presets = PRESETS.filter((p) => p <= total);
    show(`
      <h2>كم سؤالًا تريد؟</h2>
      <p class="muted">المتوفر في قاعدة الأسئلة: ${nf(total)} سؤال${unseen < total ? ` — بقي لك ${nf(unseen)} سؤال لم يظهر لك من قبل` : ""}</p>
      ${unseen === 0 ? '<p class="muted">أنهيت كل الأسئلة! ستبدأ دورة جديدة وتظهر الأسئلة من جديد.</p>' : ""}
      <div class="card stack">
        <div class="chips" id="chips">${presets.map((p) => `<button class="chip" data-n="${p}">${nf(p)}</button>`).join("")}
          ${presets.includes(total) ? "" : `<button class="chip" data-n="${total}">الكل (${nf(total)})</button>`}</div>
        <input id="rng" type="range" min="1" max="${total}" value="${count}">
        <div><label for="num">أو اكتب عددًا محددًا</label><input id="num" type="number" min="1" max="${total}" value="${count}"></div>
        <div id="msg"></div>
        <button class="big" id="go">ابدأ</button>
      </div>
      <button class="ghost" id="back">رجوع</button>`);
    const rng = $("rng"), num = $("num");
    function sync(v) {
      v = Math.max(1, Math.min(total, parseInt(v, 10) || 1));
      count = v;
      rng.value = v;
      if (document.activeElement !== num) num.value = v;
      document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", Number(c.dataset.n) === v));
    }
    sync(count);
    rng.oninput = () => { num.value = rng.value; sync(rng.value); };
    num.oninput = () => { if (num.value !== "") sync(num.value); };
    num.onblur = () => { num.value = count; };
    $("chips").onclick = (e) => {
      const b = e.target.closest(".chip");
      if (b) { num.value = b.dataset.n; sync(b.dataset.n); }
    };
    $("back").onclick = viewHome;
    $("go").onclick = async () => {
      $("go").disabled = true;
      $("go").textContent = "جارٍ تجهيز الأسئلة…";
      try {
        const r = await api("/quiz?count=" + count + "&deviceId=" + encodeURIComponent(deviceId()));
        startQuiz(r.questions, count);
      } catch (e) {
        $("msg").innerHTML = `<div class="err">${esc(e.message)}</div>`;
        $("go").disabled = false;
        $("go").textContent = "ابدأ";
      }
    };
  }

  // ---------- الاختبار ----------
  let S = null;

  function startQuiz(qs, requested) {
    S = { qs, requested, i: 0, correct: 0, answered: 0, start: performance.now(), qStart: 0, locked: false };
    renderQuestion();
    timerHandle = setInterval(() => {
      const t = $("tot");
      if (t) t.textContent = fmtTime(performance.now() - S.start);
    }, 500);
  }

  function renderQuestion() {
    const q = S.qs[S.i];
    // ترتيب عشوائي جديد للخيارات الخمسة في كل مرة يُعرض فيها السؤال (Fisher–Yates)
    const order = [0, 1, 2, 3, 4].slice(0, q.options.length);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // نسجّل على الخادم أن هذا السؤال ظهر لك حتى لا يتكرر مستقبلًا
    api("/seen", { deviceId: deviceId(), id: q.id }).catch(() => {});
    S.order = order; // order[موضع معروض] = فهرس الخيار الأصلي
    const left = S.qs.length - S.i;
    const pct = (S.i / S.qs.length) * 100;
    const keepTimer = timerHandle;
    app.innerHTML = `
      <div class="topbar">
        <span class="pill">المتبقي: ${nf(left)}</span>
        <span class="pill" id="tot">${fmtTime(performance.now() - S.start)}</span>
        <button class="ghost" id="fin" style="padding:6px 14px">إنهاء</button>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="card">
        <p class="qtext">${esc(q.q)}</p>
        <div id="opts">${order.map((orig, k) => `<button class="opt" data-k="${k}"><span class="ltr">${LETTERS[k]}</span><span>${esc(q.options[orig])}</span></button>`).join("")}</div>
        <div class="tline" id="tl"></div>
        <button class="big" id="next" disabled>${S.i + 1 === S.qs.length ? "عرض النتيجة" : "التالي"}</button>
      </div>`;
    timerHandle = keepTimer;
    S.locked = false;
    S.qStart = performance.now();
    $("opts").onclick = (e) => {
      const b = e.target.closest(".opt");
      if (b) answer(Number(b.dataset.k));
    };
    $("next").onclick = () => {
      if (S.i + 1 < S.qs.length) { S.i++; renderQuestion(); } else finish(false);
    };
    $("fin").onclick = () => {
      if (confirm("هل تريد إنهاء الاختبار الآن؟ سيتم احتساب الأسئلة التي أجبت عنها فقط.")) finish(true);
    };
  }

  function answer(k) {
    if (S.locked) return;
    S.locked = true;
    const took = performance.now() - S.qStart;
    const q = S.qs[S.i];
    const ok = S.order[k] === q.correct - 1;
    S.answered++;
    if (ok) S.correct++;
    const btns = document.querySelectorAll(".opt");
    btns.forEach((b) => (b.disabled = true));
    btns[k].classList.add(ok ? "ok" : "bad");
    if (!ok) btns[S.order.indexOf(q.correct - 1)].classList.add("ok");
    $("tl").textContent = `استغرقت ${fmtSec(took)} ثانية في هذا السؤال`;
    $("next").disabled = false;
  }

  async function finish(early) {
    const totalMs = performance.now() - S.start;
    const r = { requested: S.requested, answered: S.answered, correct: S.correct, totalTimeMs: Math.round(totalMs), finishedEarly: early };
    stopTimer();
    const wrong = r.answered - r.correct;
    const acc = r.answered ? Math.round((r.correct / r.answered) * 1000) / 10 : 0;
    const avg = r.answered ? fmtSec(totalMs / r.answered) : "0.0";
    show(`
      <h1>${early ? "تم إنهاء الاختبار" : "انتهى الاختبار"}</h1>
      <div class="card stack">
        <div class="stats">
          <div class="stat"><b>${fmtTime(totalMs)}</b><span>الوقت المستغرق</span></div>
          <div class="stat"><b>${nf(r.answered)}</b><span>أسئلة تم حلّها</span></div>
          <div class="stat"><b style="color:var(--ok)">${nf(r.correct)}</b><span>إجابات صحيحة</span></div>
          <div class="stat"><b style="color:var(--bad)">${nf(wrong)}</b><span>إجابات خاطئة</span></div>
          <div class="stat"><b>${nf(acc)}٪</b><span>نسبة الصحة</span></div>
          <div class="stat"><b>${avg}</b><span>ثانية لكل سؤال</span></div>
        </div>
        <div id="sv" class="muted small"></div>
      </div>
      <div class="row"><button id="home">الرئيسية</button><button class="ghost" id="board">لوحة الصدارة</button></div>`);
    $("home").onclick = viewHome;
    $("board").onclick = viewBoard;
    if (r.answered === 0) { $("sv").textContent = "لم تُجب عن أي سؤال، لذلك لم تُحفظ نتيجة."; return; }
    async function save() {
      $("sv").textContent = "جارٍ حفظ النتيجة…";
      try {
        await api("/result", Object.assign({ deviceId: deviceId() }, r));
        $("sv").textContent = "تم حفظ النتيجة.";
      } catch (e) {
        $("sv").innerHTML = `<span class="err">تعذّر حفظ النتيجة: ${esc(e.message)}</span> <button class="link" id="rt">أعد المحاولة</button>`;
        $("rt").onclick = save;
      }
    }
    save();
  }

  // ---------- لوحة الصدارة ----------
  async function viewBoard() {
    show('<p class="muted center">جارٍ التحميل…</p>');
    try {
      const { list, minQuestions: minQ } = await api("/leaderboard");
      const medal = (n) => (n === 1 ? "🥇" : n === 2 ? "🥈" : n === 3 ? "🥉" : nf(n));
      const rowHtml = (r) => `
        <tr class="${r.userId === user.id ? "me" : ""}">
          <td>${r.rank ? medal(r.rank) : "—"}</td><td class="nm">${esc(r.name)}</td>
          <td><b>${r.rank ? nf(r.score) : "—"}</b></td>
          <td>${nf(r.accuracy)}٪</td><td>${nf(r.correct)} / ${nf(r.total)}</td>
          <td>${(r.avgMs / 1000).toFixed(1)} ث</td>
        </tr>`;
      const table = (rows) => `<div class="tablewrap"><table>
            <thead><tr><th>#</th><th class="nm">الاسم</th><th>النقاط</th><th>الدقة</th><th>صحيحة / أسئلة</th><th>متوسط السرعة</th></tr></thead>
            <tbody>${rows.map(rowHtml).join("")}</tbody></table></div>`;
      const ranked = list.filter((r) => r.rank);
      const pending = list.filter((r) => !r.rank);
      show(`
        <h2>لوحة الصدارة</h2>
        <div class="card stack">
          ${ranked.length ? table(ranked) : '<p class="muted center">لا يوجد متسابقون مؤهلون بعد. أجب عن ' + nf(minQ) + ' سؤالًا على الأقل لتظهر في الترتيب.</p>'}
          ${pending.length ? `<h3 style="margin:8px 0 0">قيد التأهّل (أقل من ${nf(minQ)} سؤالًا)</h3>${table(pending)}` : ""}
          <p class="muted" style="font-size:13px;line-height:1.8;margin:0">
            <b>كيف تُحسب النقاط؟</b> من 100: ٨٥ نقطة للدقة الموثوقة و١٥ نقطة للسرعة.
            الدقة الموثوقة تأخذ عدد الأسئلة في الحسبان، فمن أجاب ٩٠٪ من ٢٠٠ سؤال يتقدّم على من أجاب ١٠٠٪ من ١٠ أسئلة فقط، لأن النتيجة الأكبر أصدق وأقل احتمالًا للحظ.
            السرعة تُحتسب بمقدار دقتك، فلا فائدة من التخمين السريع. عند التعادل: الأكثر إجابات صحيحة ثم الأسرع.
          </p>
        </div>
        <button class="ghost" id="b">رجوع</button>`);
      $("b").onclick = viewHome;
    } catch (e) {
      show(`<div class="card stack"><div class="err">${esc(e.message)}</div><button id="b">رجوع</button></div>`);
      $("b").onclick = viewHome;
    }
  }

  // ---------- رفع ملف الإكسل ----------
  function parseWorkbook(buf) {
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: true });
    const cell = (v) => String(v == null ? "" : v).trim();
    const good = [];
    const bad = [];
    let start = 0;
    if (rows.length) {
      const c = Number(cell(rows[0][6]));
      if (!(Number.isInteger(c) && c >= 1 && c <= 5)) start = 1; // الصف الأول عناوين
    }
    let total = 0;
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const vals = [0, 1, 2, 3, 4, 5, 6].map((k) => cell(r[k]));
      if (vals.every((v) => v === "")) continue; // صف فارغ
      total++;
      const q = vals[0];
      const o = vals.slice(1, 6);
      const c = Number(vals[6]);
      let reason = "";
      if (!q) reason = "نص السؤال فارغ";
      else if (o.some((x) => !x)) reason = "أحد الخيارات الخمسة فارغ";
      else if (!(Number.isInteger(c) && c >= 1 && c <= 5)) reason = "رقم الإجابة الصحيحة يجب أن يكون من 1 إلى 5";
      if (reason) bad.push({ row: i + 1, reason });
      else good.push({ q, o, c });
    }
    return { total, good, bad };
  }

  function viewImport() {
    show(`
      <h2>إضافة أسئلة</h2>
      <div class="card stack">
        <p style="margin:0">ارفع ملف إكسل واحدًا أو عدة ملفات دفعة واحدة (‎.xlsx‎، بلا حد لعدد الملفات) بالصيغة التالية: العمود الأول السؤال، ثم خمسة أعمدة للخيارات، ثم رقم الإجابة الصحيحة (من 1 إلى 5).</p>
        <p style="margin:0"><a href="namozaj-asila.xlsx" download>تحميل ملف نموذجي</a></p>
        <input type="file" id="file" accept=".xlsx,.xls" multiple>
        <div id="out" class="stack"></div>
      </div>
      <button class="ghost" id="b">رجوع</button>`);
    $("b").onclick = viewHome;
    $("file").onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const out = $("out");
      const good = [];
      const bad = [];
      const perFile = [];
      let total = 0;
      // نقرأ كل الملفات المحددة واحدًا تلو الآخر مهما كان عددها
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        out.innerHTML = `<p class="muted">جارٍ قراءة الملف ${nf(i + 1)} من ${nf(files.length)}: ${esc(f.name)}…</p>`;
        await new Promise((r) => setTimeout(r, 20));
        try {
          const res = parseWorkbook(await f.arrayBuffer());
          total += res.total;
          for (const g of res.good) good.push(g);
          for (const x of res.bad) bad.push(Object.assign({ file: f.name }, x));
          perFile.push({ name: f.name, total: res.total, ok: res.good.length, bad: res.bad.length, err: "" });
        } catch (err) {
          perFile.push({ name: f.name, total: 0, ok: 0, bad: 0, err: "تعذّرت قراءة الملف (تأكد أنه ملف إكسل سليم)" });
        }
      }
      const multi = files.length > 1;
      out.innerHTML = `
        <div class="stats">
          <div class="stat"><b>${nf(total)}</b><span>عدد الأسئلة${multi ? " في كل الملفات" : " في الملف"}</span></div>
          <div class="stat"><b style="color:var(--ok)">${nf(good.length)}</b><span>صالحة للحفظ</span></div>
          <div class="stat"><b style="color:var(--bad)">${nf(bad.length)}</b><span>فيها خطأ (لن تُحفظ)</span></div>
        </div>
        ${multi ? `<div class="tablewrap"><table style="min-width:0">
          <thead><tr><th class="nm">الملف</th><th>أسئلة</th><th>صالحة</th><th>خطأ</th></tr></thead>
          <tbody>${perFile.map((p) => `<tr><td class="nm">${esc(p.name)}${p.err ? `<br><span class="err">${esc(p.err)}</span>` : ""}</td><td>${nf(p.total)}</td><td>${nf(p.ok)}</td><td>${nf(p.bad)}</td></tr>`).join("")}</tbody></table></div>` : (perFile[0] && perFile[0].err ? `<div class="err">${esc(perFile[0].err)}</div>` : "")}
        ${bad.length ? `<div class="fails">${bad.slice(0, 50).map((b) => `${multi ? esc(b.file) + " — " : ""}الصف ${nf(b.row)}: ${esc(b.reason)}`).join("<br>")}${bad.length > 50 ? `<br>… و${nf(bad.length - 50)} صفًا آخر` : ""}</div>` : ""}
        ${good.length ? `
          <div><label for="pw">كلمة المرور لحفظ الأسئلة</label><input id="pw" type="password" inputmode="numeric" autocomplete="off"></div>
          <div id="msg"></div>
          <button class="big" id="save">حفظ الأسئلة</button>` : '<div class="err">لا توجد أسئلة صالحة للحفظ.</div>'}`;
      if (!good.length) return;
      $("save").onclick = () => saveAll(good, bad.length, total);
    };
  }

  async function saveAll(good, invalidCount, total) {
    const pw = $("pw").value;
    if (!pw) { $("msg").innerHTML = '<div class="err">اكتب كلمة المرور أولًا</div>'; return; }
    $("save").disabled = true;
    $("file").disabled = true;
    $("msg").innerHTML = '<div class="progress"><i id="pg"></i></div><p class="muted small" id="pt">جارٍ الحفظ…</p>';
    let inserted = 0, dup = 0, srvInvalid = 0, errFail = 0, done = 0;
    for (let i = 0; i < good.length; i += CHUNK) {
      const part = good.slice(i, i + CHUNK);
      let r = null;
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try {
          r = await api("/import", { password: pw, rows: part });
        } catch (e) {
          if (e.status === 403) {
            $("msg").innerHTML = `<div class="err">كلمة المرور غير صحيحة${i ? " (تم حفظ ما سبق من الدفعات)" : ""}</div>`;
            $("save").disabled = false;
            $("file").disabled = false;
            return;
          }
        }
      }
      if (r) { inserted += r.inserted; dup += r.duplicates; srvInvalid += r.invalid; }
      else errFail += part.length;
      done += part.length;
      $("pg").style.width = (done / good.length) * 100 + "%";
      $("pt").textContent = `تمت معالجة ${nf(done)} من ${nf(good.length)}`;
    }
    const failed = invalidCount + dup + srvInvalid + errFail;
    $("msg").innerHTML = `
      <div class="${errFail ? "err" : "okmsg"}">اكتملت العملية.</div>
      <div class="stats" style="margin-top:10px">
        <div class="stat"><b>${nf(total)}</b><span>أسئلة في الملفات</span></div>
        <div class="stat"><b style="color:var(--ok)">${nf(inserted)}</b><span>نجح حفظها</span></div>
        <div class="stat"><b style="color:var(--bad)">${nf(failed)}</b><span>فشل حفظها</span></div>
      </div>
      <p class="muted small">من أسباب الفشل: ${nf(invalidCount + srvInvalid)} فيها خطأ في البيانات، ${nf(dup)} مكررة (موجودة مسبقًا)${errFail ? `، ${nf(errFail)} لم تُحفظ بسبب خطأ في الاتصال، أعد رفع الملف لحفظها` : ""}.</p>`;
  }

  init();
})();
