/* خادم بسيط بدون مكتبات خارجية: يقدّم ملفات الموقع ويتحقق من دخول الأستاذ من ملف exam.env */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const ENV_FILE = "exam.env"; // اسم ملف الإعدادات (غيّره هنا إن أردت اسمًا آخر)
const ENV_PATH = path.join(ROOT, ENV_FILE);

function loadEnv() {
  // الأولوية: القيم داخل exam.env، وإن لم يوجد الملف تُؤخذ من متغيرات بيئة الاستضافة (Render / Railway ...)
  const out = {};
  ["TEACHER_USERNAME", "TEACHER_PASSWORD"].forEach((k) => { if (process.env[k]) out[k] = process.env[k]; });
  if (!fs.existsSync(ENV_PATH)) return out;
  // يتجاهل BOM وأسطر التعليق، ويقبل القيم بين علامتي اقتباس أو بدونها
  fs.readFileSync(ENV_PATH, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  });
  return out;
}
function saveEnvValue(key, value) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const re = new RegExp("^\\s*" + key + "\\s*=.*$", "m");
  text = re.test(text) ? text.replace(re, () => key + "=" + value) : text.replace(/\s*$/, "\n") + key + "=" + value + "\n";
  fs.writeFileSync(ENV_PATH, text);
}

let env = loadEnv();
if (!env.TEACHER_USERNAME || !env.TEACHER_PASSWORD) {
  console.error("خطأ: عرّف TEACHER_USERNAME و TEACHER_PASSWORD داخل ملف " + ENV_FILE + " أو في متغيرات بيئة الاستضافة");
  process.exit(1);
}
const PORT = Number(process.env.PORT || env.PORT || 3000);

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 10000) { req.destroy(); reject(new Error("too large")); } });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

// حماية بسيطة من تخمين كلمة المرور: 5 محاولات فاشلة ← انتظار دقيقة
const fails = new Map();
function blocked(ip) {
  const f = fails.get(ip);
  return f && f.count >= 5 && Date.now() - f.last < 60000;
}
function noteFail(ip) {
  const f = fails.get(ip) || { count: 0, last: 0 };
  f.count = Date.now() - f.last > 60000 ? 1 : f.count + 1;
  f.last = Date.now();
  fails.set(ip, f);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};
const HIDDEN = new Set(["server.js", "package.json", "package-lock.json"]);

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ip = req.socket.remoteAddress;

  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, { ok: true, version: 2 });
  }

  if (req.method === "POST" && url.pathname === "/api/teacher-login") {
    if (blocked(ip)) return json(res, 429, { ok: false, message: "محاولات كثيرة. انتظر دقيقة ثم حاول مرة أخرى." });
    const { username = "", password = "" } = await readBody(req);
    env = loadEnv();
    const userOk = safeEqual(String(username).trim().toLowerCase(), env.TEACHER_USERNAME.trim().toLowerCase());
    const passOk = safeEqual(password, env.TEACHER_PASSWORD);
    if (userOk && passOk) {
      fails.delete(ip);
      return json(res, 200, { ok: true, username: env.TEACHER_USERNAME });
    }
    noteFail(ip);
    console.log("[دخول فاشل] اسم المستخدم " + (userOk ? "مطابق" : "غير مطابق") + " — كلمة المرور " + (passOk ? "مطابقة" : "غير مطابقة"));
    return json(res, 401, { ok: false, message: "اسم المستخدم أو كلمة المرور غير صحيحة." });
  }

  if (req.method === "POST" && url.pathname === "/api/teacher-change-password") {
    if (blocked(ip)) return json(res, 429, { ok: false, message: "محاولات كثيرة. انتظر دقيقة ثم حاول مرة أخرى." });
    const { currentPassword = "", newPassword = "" } = await readBody(req);
    env = loadEnv();
    if (!safeEqual(currentPassword, env.TEACHER_PASSWORD)) {
      noteFail(ip);
      return json(res, 401, { ok: false, message: "كلمة المرور الحالية غير صحيحة." });
    }
    if (String(newPassword).length < 6 || /[\r\n]/.test(newPassword)) {
      return json(res, 400, { ok: false, message: "كلمة المرور الجديدة غير صالحة." });
    }
    saveEnvValue("TEACHER_PASSWORD", newPassword);
    return json(res, 200, { ok: true });
  }

  // ملفات الموقع الثابتة
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  const name = path.basename(file);
  if (!file.startsWith(ROOT + path.sep) || name.startsWith(".") || name.endsWith(".env") || name.endsWith(".env.example") || HIDDEN.has(name)) {
    res.writeHead(404); return res.end("Not found");
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log("الموقع يعمل على: http://localhost:" + PORT);
  console.log("ملف الإعدادات: " + ENV_PATH);
  console.log("اسم المستخدم المحمّل: " + env.TEACHER_USERNAME + " — طول كلمة المرور: " + env.TEACHER_PASSWORD.length + " حرفًا");
});
