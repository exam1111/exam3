/* Local authentication and route guards. No external authentication service. */
const TEACHER_SESSION_KEY = "exam_teacher_session";
const STUDENT_SESSION_KEY = "exam_student_session";
const TEACHER_RECORD_KEY = "exam_teacher_record";

/* اسم المستخدم وكلمة المرور محفوظان في ملف exam.env على الخادم (server.js) ولا يوجدان في هذا الملف. */
function getTeacherRecord() {
  try {
    const saved = JSON.parse(localStorage.getItem(TEACHER_RECORD_KEY) || "null");
    if (saved) {
      if ("password" in saved) { delete saved.password; localStorage.setItem(TEACHER_RECORD_KEY, JSON.stringify(saved)); }
      return saved;
    }
  } catch {}
  return { uid: "teacher-local-1", email: "", name: "الأستاذ" };
}
function saveTeacherRecord(record) {
  localStorage.setItem(TEACHER_RECORD_KEY, JSON.stringify(record));
}
async function _teacherApi(path, body) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw { code: "network", message: "تعذر الاتصال بالخادم. شغّل الموقع بالأمر: npm start" };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    throw { code: "auth/wrong-password", message: (data && data.message) || "تعذر الاتصال بالخادم. شغّل الموقع بالأمر: npm start" };
  }
  return data;
}
const auth = {
  currentUser: null,
  onAuthStateChanged(callback) {
    const uid = localStorage.getItem(TEACHER_SESSION_KEY);
    const studentUid = localStorage.getItem(STUDENT_SESSION_KEY);
    if (uid === "1") {
      const record = getTeacherRecord();
      this.currentUser = { uid: record.uid, email: record.email, isAnonymous: false };
    } else if (studentUid) {
      this.currentUser = { uid: studentUid, isAnonymous: true };
    } else {
      this.currentUser = null;
    }
    if (typeof callback === "function") callback(this.currentUser);
    return () => {};
  }
};

async function teacherLogin(username, password) {
  const data = await _teacherApi("/api/teacher-login", { username, password });
  const record = { ...getTeacherRecord(), email: data.username };
  saveTeacherRecord(record);
  localStorage.setItem(TEACHER_SESSION_KEY, "1");
  auth.currentUser = { uid: record.uid, email: record.email, isAnonymous: false };
  return { uid: record.uid, email: record.email, name: record.name };
}
function teacherLogout() {
  localStorage.removeItem(TEACHER_SESSION_KEY);
  window.location.href = "teacher-login.html";
}
function changeTeacherDisplayName(newName) {
  const record = getTeacherRecord();
  record.name = newName;
  saveTeacherRecord(record);
}
async function changeTeacherPassword(currentPassword, newPassword) {
  await _teacherApi("/api/teacher-change-password", { currentPassword, newPassword });
}
function guardTeacherPage(onReady) {
  if (localStorage.getItem(TEACHER_SESSION_KEY) !== "1") {
    window.location.href = "teacher-login.html";
    return;
  }
  const record = getTeacherRecord();
  onReady({ uid: record.uid, email: record.email, name: record.name });
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
