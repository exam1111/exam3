/* مصادقة الأستاذ عبر Firebase Authentication (REST) — لا توجد أي كلمة مرور داخل الكود.
   أنشئ حساب الأستاذ من لوحة Firebase: Authentication ← Users ← Add user (انظر SETUP.md). */
const TEACHER_TOKEN_KEY = "exam_teacher_token";
const STUDENT_SESSION_KEY = "exam_student_session";

function _fbKey() { return (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) || ""; }
function _readTeacherToken() {
  try { return JSON.parse(sessionStorage.getItem(TEACHER_TOKEN_KEY) || "null"); } catch { return null; }
}
function _writeTeacherToken(t) { sessionStorage.setItem(TEACHER_TOKEN_KEY, JSON.stringify(t)); }

async function _fbPost(url, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw { code: "network", message: "تعذر الاتصال بالخادم. تأكد من الإنترنت." }; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = (data.error && data.error.message) || "";
    if (/INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|INVALID_EMAIL/.test(m)) throw { code: "auth/wrong-password", message: "اسم المستخدم أو كلمة المرور غير صحيحة." };
    if (/TOO_MANY_ATTEMPTS/.test(m)) throw { code: "auth/too-many", message: "محاولات كثيرة. حاول لاحقًا." };
    if (/WEAK_PASSWORD/.test(m)) throw { code: "auth/weak", message: "كلمة المرور الجديدة ضعيفة (6 أحرف على الأقل)." };
    throw { code: "auth/error", message: "تعذّر تسجيل الدخول (" + (m || res.status) + ")." };
  }
  return data;
}

/* يعيد توكن صالحًا (ويجدّده تلقائيًا قبل انتهائه). يستعمله local-db.js مع كل طلب. */
async function getTeacherIdToken() {
  const t = _readTeacherToken();
  if (!t) return null;
  if (Date.now() < t.expiresAt - 60000) return t.idToken;
  try {
    const r = await _fbPost("https://securetoken.googleapis.com/v1/token?key=" + _fbKey(), { grant_type: "refresh_token", refresh_token: t.refreshToken });
    const next = { ...t, idToken: r.id_token, refreshToken: r.refresh_token, expiresAt: Date.now() + Number(r.expires_in) * 1000 };
    _writeTeacherToken(next);
    return next.idToken;
  } catch { sessionStorage.removeItem(TEACHER_TOKEN_KEY); return null; }
}

const auth = {
  currentUser: null,
  onAuthStateChanged(callback) {
    const t = _readTeacherToken();
    let studentUid = null;
    try { studentUid = localStorage.getItem(STUDENT_SESSION_KEY); } catch {}
    if (t) this.currentUser = { uid: t.uid, email: t.email, isAnonymous: false };
    else if (studentUid) this.currentUser = { uid: studentUid, isAnonymous: true };
    else this.currentUser = null;
    if (typeof callback === "function") callback(this.currentUser);
    return () => {};
  }
};

async function teacherLogin(username, password) {
  if (!_fbKey()) throw { code: "auth/config", message: "لم يتم ضبط apiKey في config.js (انظر SETUP.md)." };
  const r = await _fbPost("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + _fbKey(),
    { email: username.trim(), password, returnSecureToken: true });
  _writeTeacherToken({ uid: r.localId, email: r.email, idToken: r.idToken, refreshToken: r.refreshToken, expiresAt: Date.now() + Number(r.expiresIn) * 1000 });
  auth.currentUser = { uid: r.localId, email: r.email, isAnonymous: false };
  return { uid: r.localId, email: r.email, name: getTeacherDisplayName() };
}
function teacherLogout() {
  sessionStorage.removeItem(TEACHER_TOKEN_KEY);
  window.location.href = "teacher-login.html";
}
/* الاسم المعروض غير سرّي، لذا يكفي حفظه محليًا */
function getTeacherDisplayName() { return localStorage.getItem("exam_teacher_name") || "الأستاذ"; }
function changeTeacherDisplayName(newName) { localStorage.setItem("exam_teacher_name", newName); }

async function changeTeacherPassword(currentPassword, newPassword) {
  const t = _readTeacherToken();
  if (!t) throw { code: "auth/wrong-password", message: "انتهت الجلسة، سجّل الدخول من جديد." };
  // تحقق من كلمة المرور الحالية ثم غيّرها على الخادم
  const r = await _fbPost("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + _fbKey(),
    { email: t.email, password: currentPassword, returnSecureToken: true });
  const u = await _fbPost("https://identitytoolkit.googleapis.com/v1/accounts:update?key=" + _fbKey(),
    { idToken: r.idToken, password: newPassword, returnSecureToken: true });
  _writeTeacherToken({ ...t, idToken: u.idToken, refreshToken: u.refreshToken, expiresAt: Date.now() + Number(u.expiresIn) * 1000 });
}
function guardTeacherPage(onReady) {
  const t = _readTeacherToken();
  if (!t) { window.location.href = "teacher-login.html"; return; }
  onReady({ uid: t.uid, email: t.email, name: getTeacherDisplayName() });
}
/* ---------- هوية الجهاز (تُخزَّن في 3 أماكن حتى لا يكفي مسح واحد منها) ----------
   معرّف الطالب = معرّف الجهاز/المتصفح، وهو مفتاح المحاولة (امتحان + معرّف).
   لذلك لا يفيد تغيير الاسم في الدخول مرة ثانية بعد التسليم. */
const DEVICE_COOKIE = "exam_device_id";

function _cookieGet(name) {
  try {
    const row = document.cookie.split("; ").find((r) => r.startsWith(name + "="));
    return row ? decodeURIComponent(row.slice(name.length + 1)) : null;
  } catch { return null; }
}
function _cookieSet(name, value) {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${60 * 60 * 24 * 365 * 3}; path=/; SameSite=Lax`;
  } catch {}
}
function _idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("no-idb"));
    const req = indexedDB.open("exam_device_db", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function _withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((res) => setTimeout(() => res(null), ms))]);
}
async function _idbGet(key) {
  try {
    const d = await _idbOpen();
    return await new Promise((res) => {
      const r = d.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}
async function _idbSet(key, val) {
  try {
    const d = await _idbOpen();
    await new Promise((res) => {
      const tx = d.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = tx.onerror = tx.onabort = () => res();
    });
  } catch {}
}

async function ensureStudentSession() {
  let uid = null;
  try { uid = localStorage.getItem(STUDENT_SESSION_KEY); } catch {}
  if (!uid) uid = _cookieGet(DEVICE_COOKIE);
  if (!uid) uid = await _withTimeout(_idbGet(STUDENT_SESSION_KEY), 1500);
  if (!uid) uid = "student-" + simpleId();
  // أعد كتابة المعرّف في كل الأماكن (يستعيد ما تم مسحه منها)
  try { localStorage.setItem(STUDENT_SESSION_KEY, uid); } catch {}
  _cookieSet(DEVICE_COOKIE, uid);
  await _withTimeout(_idbSet(STUDENT_SESSION_KEY, uid), 1500);
  auth.currentUser = { uid, isAnonymous: true };
  return { uid, isAnonymous: true };
}
function upsertStudentProfile(uid, fullName) {
  return db.collection(COLLECTIONS.STUDENTS).doc(uid).set({ fullName, lastSeenAt: serverTimestamp() }, {merge:true});
}
function guardStudentSession() { return ensureStudentSession(); }
