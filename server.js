// خادم ملفات ثابتة بسيط بلا أي مكتبات (يُستخدم فقط إذا نشرته على Render كـ Web Service)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = new Set(["index.html", "app.js", "localdb.js", "style.css", "namozaj-asila.xlsx"]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      return res.end("ok");
    }
    const name = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    if (!PUBLIC.has(name)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("غير موجود");
    }
    fs.readFile(path.join(ROOT, name), (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("خطأ");
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(name)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  })
  .listen(PORT, "0.0.0.0", () => console.log("Listening on " + PORT));
