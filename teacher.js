/**
 * teacher.js
 * يغطي هذا الملف صفحتين خاصتين بالأستاذ فقط (محميتين بـ guardTeacherPage):
 *   1) teacher-dashboard.html — الإحصاءات وقائمة الامتحانات وإعدادات الحساب
 *   2) create-exam.html      — إنشاء/تعديل امتحان وإدارة أسئلته والإجابة الصحيحة
 *
 * كل الوظائف هنا تفترض أن guardTeacherPage نجحت بالفعل، لكنها لا تعتمد
 * عليها وحدها كحماية: أي محاولة كتابة غير مصرّح بها سترفضها الخدمة السحابية
 * Security Rules من جهة الخادم أيضًا.
 */

let currentTeacher = null;


/* ======================================================================
   1) لوحة التحكم
   ====================================================================== */

async function initDashboardPage() {
  wireLogoutAndAccount();

  const tbody = document.getElementById("examsTbody");
  const alertBox = document.getElementById("alertBox");

  try {
    const examsSnap = await db
      .collection(COLLECTIONS.EXAMS)
      .orderBy("createdAt", "desc")
      .get();

    const exams = examsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // نجلب عدد المحاولات لكل امتحان لعرضه في الجدول ولحساب الإحصاءات الكلية
    const studentUids = new Set();
    let totalAttempts = 0;
    for (const exam of exams) {
      const attemptsSnap = await db.collection(COLLECTIONS.ATTEMPTS).where("examId", "==", exam.id).get();
      exam.attemptsCount = attemptsSnap.size;
      attemptsSnap.forEach((d) => studentUids.add(d.data().studentUid));
      totalAttempts += attemptsSnap.size;
    }

    const now = Date.now();
    const isActive = (e) => e.status === "published" && now >= tsMs(e.startAt) && now <= tsMs(e.endAt);
    const isEnded = (e) => e.status === "closed" || now > tsMs(e.endAt);

    renderStats({
      total: exams.length,
      active: exams.filter(isActive).length,
      ended: exams.filter(isEnded).length,
      students: studentUids.size,
      attempts: totalAttempts,
    });

    if (exams.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">لا توجد امتحانات بعد. ابدأ بإنشاء أول امتحان.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    exams.forEach((exam) => tbody.appendChild(buildExamRow(exam)));
  } catch (err) {
    console.error(err);
    showAlert(alertBox, translateError(err), "error");
  }
}

function tsMs(v) {
  return v?.toDate ? v.toDate().getTime() : new Date(v).getTime();
}

function renderStats({ total, active, ended, students, attempts }) {
  const grid = document.getElementById("statGrid");
  const cards = grid.querySelectorAll(".stat-card .num");
  const values = [total, active, ended, students, attempts];
  cards.forEach((el, i) => (el.textContent = values[i] ?? "0"));
}

function statusBadge(status) {
  const map = { draft: ["مسودة", "draft"], published: ["منشور", "published"], closed: ["مغلق", "closed"] };
  const [label, cls] = map[status] || [status, "draft"];
  return `<span class="badge badge-${cls}">${label}</span>`;
}

function buildExamRow(exam) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${escapeHtml(exam.title)}</td>
    <td>${statusBadge(exam.status)}</td>
    <td class="ltr">${formatDateTime(exam.startAt)}</td>
    <td class="ltr">${formatDateTime(exam.endAt)}</td>
    <td>${exam.durationMinutes} د</td>
    <td>${exam.questionCount || 0}</td>
    <td>${exam.attemptsCount || 0}</td>
    <td>
      <div class="flex gap-8" style="flex-wrap:wrap;">
        <a class="btn btn-outline btn-sm" href="create-exam.html?exam=${exam.id}">تعديل / الأسئلة</a>
        <a class="btn btn-outline btn-sm" href="results.html?exam=${exam.id}">النتائج</a>
        ${exam.status !== "closed" ? `<button class="btn btn-warn btn-sm" data-action="close" data-id="${exam.id}">إغلاق</button>` : ""}
        <button class="btn btn-danger btn-sm" data-action="delete" data-id="${exam.id}" data-title="${escapeHtml(exam.title)}">حذف</button>
      </div>
    </td>
  `;
  tr.querySelector('[data-action="close"]')?.addEventListener("click", () => confirmCloseExam(exam.id));
  tr.querySelector('[data-action="delete"]')?.addEventListener("click", () => confirmDeleteExam(exam.id, exam.title));
  return tr;
}

function confirmCloseExam(examId) {
  openConfirm("إغلاق الامتحان", "لن يتمكن أي طالب من الدخول لهذا الامتحان بعد إغلاقه. هل تريد المتابعة؟", async () => {
    await db.collection(COLLECTIONS.EXAMS).doc(examId).update({ status: "closed" });
    location.reload();
  });
}

function confirmDeleteExam(examId, title) {
  openConfirm(
    "حذف الامتحان نهائيًا",
    `سيتم حذف الامتحان "${title}" وجميع أسئلته ومحاولات الطلاب والنتائج المرتبطة به نهائيًا. هذا الإجراء لا يمكن التراجع عنه.`,
    async () => {
      await deleteExamCascade(examId);
      location.reload();
    }
  );
}

async function deleteExamCascade(examId) {
  const collectionsToClean = [
    { name: COLLECTIONS.QUESTIONS, field: "examId" },
    { name: COLLECTIONS.ATTEMPTS, field: "examId" },
    { name: COLLECTIONS.ANSWERS, field: "examId" },
    { name: COLLECTIONS.VIOLATIONS, field: "examId" },
  ];
  for (const col of collectionsToClean) {
    const snap = await db.collection(col.name).where(col.field, "==", examId).get();
    await batchDelete(snap.docs.map((d) => d.ref));
    if (col.name === COLLECTIONS.QUESTIONS) {
      // نحذف أيضًا مفاتيح الإجابة المرتبطة بنفس معرّفات الأسئلة
      const keyRefs = snap.docs.map((d) => db.collection(COLLECTIONS.ANSWER_KEYS).doc(d.id));
      await batchDelete(keyRefs);
    }
  }
  await db.collection(COLLECTIONS.EXAMS).doc(examId).delete();
}

async function batchDelete(refs) {
  const chunkSize = 400;
  for (let i = 0; i < refs.length; i += chunkSize) {
    const batch = db.batch();
    refs.slice(i, i + chunkSize).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

function openConfirm(title, message, onConfirm) {
  const modal = document.getElementById("confirmModal");
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  modal.classList.remove("hidden");
  const okBtn = document.getElementById("confirmOkBtn");
  const cancelBtn = document.getElementById("confirmCancelBtn");
  const newOk = okBtn.cloneNode(true); // لإزالة أي مستمعين سابقين
  okBtn.parentNode.replaceChild(newOk, okBtn);
  newOk.addEventListener("click", async () => {
    newOk.disabled = true;
    newOk.textContent = "جاري التنفيذ...";
    try {
      await onConfirm();
    } catch (err) {
      console.error(err);
      alert(translateError(err));
      modal.classList.add("hidden");
    }
  });
  cancelBtn.onclick = () => modal.classList.add("hidden");
}

function wireLogoutAndAccount() {
  const logoutLink = document.getElementById("logoutLink");
  logoutLink?.addEventListener("click", (e) => {
    e.preventDefault();
    teacherLogout();
  });

  const accountLink = document.getElementById("accountLink");
  const accountModal = document.getElementById("accountModal");
  if (!accountLink || !accountModal) return;

  accountLink.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("displayNameInput").value = currentTeacher.name || "";
    clearAlert(document.getElementById("accountAlert"));
    accountModal.classList.remove("hidden");
  });
  document.getElementById("closeAccountModal").addEventListener("click", () => accountModal.classList.add("hidden"));

  document.getElementById("saveNameBtn").addEventListener("click", async () => {
    const alertEl = document.getElementById("accountAlert");
    const newName = document.getElementById("displayNameInput").value.trim();
    if (!newName) return showAlert(alertEl, "يرجى إدخال اسم صالح.", "error");
    try {
      await changeTeacherDisplayName(newName);
      currentTeacher.name = newName;
      document.getElementById("userChip").textContent = `${newName} 👋`;
      showAlert(alertEl, "تم تحديث الاسم بنجاح.", "success");
    } catch (err) {
      showAlert(alertEl, translateError(err), "error");
    }
  });

  document.getElementById("savePasswordBtn").addEventListener("click", async () => {
    const alertEl = document.getElementById("accountAlert");
    const current = document.getElementById("currentPasswordInput").value;
    const next = document.getElementById("newPasswordInput").value;
    if (!current || !next) return showAlert(alertEl, "يرجى تعبئة كلمة المرور الحالية والجديدة.", "error");
    if (next.length < 6) return showAlert(alertEl, "كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل.", "error");
    try {
      await changeTeacherPassword(current, next);
      showAlert(alertEl, "تم تغيير كلمة المرور بنجاح.", "success");
      document.getElementById("currentPasswordInput").value = "";
      document.getElementById("newPasswordInput").value = "";
    } catch (err) {
      showAlert(alertEl, translateError(err), "error");
    }
  });
}

/* ======================================================================
   2) إنشاء / تعديل امتحان + إدارة الأسئلة
   ====================================================================== */

let examCtx = {
  examId: null,
  exam: null,
  questions: [],
};

async function initCreateExamPage() {
  const params = new URLSearchParams(window.location.search);
  examCtx.examId = params.get("exam");
  const alertBox = document.getElementById("alertBox");

  if (examCtx.examId) {
    document.getElementById("pageTitle").textContent = "تعديل الامتحان وإدارة أسئلته";
    try {
      const doc = await db.collection(COLLECTIONS.EXAMS).doc(examCtx.examId).get();
      if (!doc.exists) {
        showAlert(alertBox, "لا تملك صلاحية الوصول لهذا الامتحان.", "error");
        document.getElementById("examForm").classList.add("hidden");
        return;
      }
      examCtx.exam = doc.data();
      fillExamForm(examCtx.exam);
      document.getElementById("questionsSection").classList.remove("hidden");
      await loadQuestions();
    } catch (err) {
      showAlert(alertBox, translateError(err), "error");
    }
  }

  wireExamForm();
  wireQuestionModal();
  wireBulkModal();
}

function toLocalInputValue(tsOrDate) {
  const date = tsOrDate?.toDate ? tsOrDate.toDate() : new Date(tsOrDate);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fillExamForm(exam) {
  document.getElementById("title").value = exam.title;
  document.getElementById("description").value = exam.description || "";
  document.getElementById("examCode").value = exam.examCode;
  document.getElementById("status").value = exam.status;
  document.getElementById("startAt").value = toLocalInputValue(exam.startAt);
  document.getElementById("endAt").value = toLocalInputValue(exam.endAt);
  document.getElementById("durationMinutes").value = exam.durationMinutes;
  document.getElementById("questionCountDisplay").value = exam.questionCount || 0;
  document.getElementById("allowShowAnswers").checked = !!exam.allowShowAnswers;
}

function wireExamForm() {
  const form = document.getElementById("examForm");
  const alertBox = document.getElementById("alertBox");
  const saveBtn = document.getElementById("saveExamBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alertBox);

    const title = document.getElementById("title").value.trim();
    const description = document.getElementById("description").value.trim();
    const examCode = document.getElementById("examCode").value.trim().toUpperCase();
    const status = document.getElementById("status").value;
    const startAtStr = document.getElementById("startAt").value;
    const endAtStr = document.getElementById("endAt").value;
    const durationMinutes = Number(document.getElementById("durationMinutes").value);
    const allowShowAnswers = document.getElementById("allowShowAnswers").checked;

    if (!title || !examCode || !startAtStr || !endAtStr || !durationMinutes) {
      showAlert(alertBox, "يرجى تعبئة جميع الحقول المطلوبة.", "error");
      return;
    }
    const startAt = new Date(startAtStr);
    const endAt = new Date(endAtStr);
    if (endAt <= startAt) {
      showAlert(alertBox, "يجب أن يكون وقت النهاية بعد وقت البداية.", "error");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "جاري الحفظ...";

    try {
      // تأكد أن رمز الامتحان غير مستخدم من امتحان آخر لنفس الأستاذ أو غيره
      const dupSnap = await db.collection(COLLECTIONS.EXAMS).where("examCode", "==", examCode).limit(2).get();
      const conflict = dupSnap.docs.find((d) => d.id !== examCtx.examId);
      if (conflict) {
        showAlert(alertBox, "رمز الامتحان هذا مستخدم من قبل، اختر رمزًا آخر.", "error");
        saveBtn.disabled = false;
        saveBtn.textContent = "حفظ بيانات الامتحان";
        return;
      }

      const payload = {
        title,
        description,
        examCode,
        status,
        startAt: startAt,
        endAt: endAt,
        durationMinutes,
        allowShowAnswers,
        teacherId: currentTeacher.uid,
      };

      if (examCtx.examId) {
        await db.collection(COLLECTIONS.EXAMS).doc(examCtx.examId).update(payload);
        showAlert(alertBox, "تم حفظ التعديلات بنجاح.", "success");
      } else {
        payload.createdAt = serverTimestamp();
        payload.questionCount = 0;
        const ref = await db.collection(COLLECTIONS.EXAMS).add(payload);
        window.location.href = `create-exam.html?exam=${ref.id}`;
        return;
      }
      saveBtn.disabled = false;
      saveBtn.textContent = "حفظ بيانات الامتحان";
    } catch (err) {
      console.error(err);
      showAlert(alertBox, translateError(err), "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "حفظ بيانات الامتحان";
    }
  });
}

/* ---------------------- إدارة الأسئلة ---------------------- */

async function loadQuestions() {
  const snap = await db
    .collection(COLLECTIONS.QUESTIONS)
    .where("examId", "==", examCtx.examId)
    .orderBy("order")
    .get();
  examCtx.questions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderQuestionsList();
}

const typeLabels = {
  multiple_choice: "اختيار من متعدد",
  true_false: "صح / خطأ",
  short_answer: "إجابة قصيرة",
  essay: "مقالي",
};

function renderQuestionsList() {
  const list = document.getElementById("questionsList");
  const empty = document.getElementById("noQuestions");
  document.getElementById("qCount").textContent = examCtx.questions.length;

  if (examCtx.questions.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  list.innerHTML = "";

  examCtx.questions.forEach((q, index) => {
    const card = document.createElement("div");
    card.className = "q-card";
    card.innerHTML = `
      <div class="q-head">
        <div>
          <span class="badge badge-progress">${typeLabels[q.type]}</span>
          <span class="muted small">— ${q.points} ${q.points === 1 ? "درجة" : "درجات"}</span>
        </div>
        <div class="flex gap-8">
          <div class="q-order-btns">
            <button data-act="up" ${index === 0 ? "disabled" : ""} title="نقل لأعلى">▲</button>
            <button data-act="down" ${index === examCtx.questions.length - 1 ? "disabled" : ""} title="نقل لأسفل">▼</button>
          </div>
          <button class="btn btn-outline btn-sm" data-act="edit">تعديل</button>
          <button class="btn btn-danger btn-sm" data-act="delete">حذف</button>
        </div>
      </div>
      <div class="ltr" style="direction:ltr; text-align:left;">${escapeHtml(q.text)}</div>
    `;
    card.querySelector('[data-act="edit"]').addEventListener("click", () => openQuestionModal(q));
    card.querySelector('[data-act="delete"]').addEventListener("click", () => confirmDeleteQuestion(q));
    card.querySelector('[data-act="up"]')?.addEventListener("click", () => moveQuestion(index, -1));
    card.querySelector('[data-act="down"]')?.addEventListener("click", () => moveQuestion(index, 1));
    list.appendChild(card);
  });
}

async function moveQuestion(index, direction) {
  const otherIndex = index + direction;
  if (otherIndex < 0 || otherIndex >= examCtx.questions.length) return;
  const a = examCtx.questions[index];
  const b = examCtx.questions[otherIndex];
  const batch = db.batch();
  batch.update(db.collection(COLLECTIONS.QUESTIONS).doc(a.id), { order: b.order });
  batch.update(db.collection(COLLECTIONS.QUESTIONS).doc(b.id), { order: a.order });
  await batch.commit();
  await loadQuestions();
}

function confirmDeleteQuestion(q) {
  openConfirm("حذف السؤال", "سيتم حذف هذا السؤال نهائيًا من الامتحان. هل تريد المتابعة؟", async () => {
    const batch = db.batch();
    batch.delete(db.collection(COLLECTIONS.QUESTIONS).doc(q.id));
    batch.delete(db.collection(COLLECTIONS.ANSWER_KEYS).doc(q.id));
    await batch.commit();
    await renumberQuestions();
    await syncQuestionCount();
    await loadQuestions();
  });
}

async function renumberQuestions() {
  const snap = await db.collection(COLLECTIONS.QUESTIONS).where("examId", "==", examCtx.examId).orderBy("order").get();
  const batch = db.batch();
  snap.docs.forEach((doc, i) => batch.update(doc.ref, { order: i }));
  await batch.commit();
}

async function syncQuestionCount() {
  const snap = await db.collection(COLLECTIONS.QUESTIONS).where("examId", "==", examCtx.examId).get();
  await db.collection(COLLECTIONS.EXAMS).doc(examCtx.examId).update({ questionCount: snap.size });
  document.getElementById("questionCountDisplay").value = snap.size;
}

let editingQuestionId = null;

function wireQuestionModal() {
  document.getElementById("addQuestionBtn").addEventListener("click", () => openQuestionModal(null));
  document.getElementById("cancelQuestionBtn").addEventListener("click", () => closeQuestionModal());
  document.getElementById("qType").addEventListener("change", updateQuestionModalFields);
  document.getElementById("saveQuestionBtn").addEventListener("click", saveQuestion);
}

function openQuestionModal(question) {
  editingQuestionId = question ? question.id : null;
  document.getElementById("qModalTitle").textContent = question ? "تعديل السؤال" : "إضافة سؤال";
  clearAlert(document.getElementById("qModalAlert"));

  document.getElementById("qType").value = question ? question.type : "multiple_choice";
  document.getElementById("qText").value = question ? question.text : "";
  document.getElementById("qPoints").value = question ? question.points : 1;
  document.getElementById("optA").value = question?.options?.a || "";
  document.getElementById("optB").value = question?.options?.b || "";
  document.getElementById("optC").value = question?.options?.c || "";
  document.getElementById("optD").value = question?.options?.d || "";
  document.getElementById("mcCorrect").value = "a";
  document.getElementById("tfCorrect").value = "true";
  document.getElementById("acceptableAnswers").value = "";

  updateQuestionModalFields();
  document.getElementById("questionModal").classList.remove("hidden");

  if (question) {
    // نجلب مفتاح الإجابة الصحيحة (متاح للأستاذ فقط عبر قواعد الأمان) لتعبئته في النموذج
    db.collection(COLLECTIONS.ANSWER_KEYS)
      .doc(question.id)
      .get()
      .then((keyDoc) => {
        if (!keyDoc.exists) return;
        const key = keyDoc.data();
        if (question.type === "multiple_choice") document.getElementById("mcCorrect").value = key.correctAnswer;
        if (question.type === "true_false") document.getElementById("tfCorrect").value = key.correctAnswer;
        if (question.type === "short_answer") document.getElementById("acceptableAnswers").value = (key.acceptableAnswers || []).join(", ");
      });
  }
}

function closeQuestionModal() {
  document.getElementById("questionModal").classList.add("hidden");
  editingQuestionId = null;
}

function updateQuestionModalFields() {
  const type = document.getElementById("qType").value;
  document.getElementById("mcOptions").classList.toggle("hidden", type !== "multiple_choice");
  document.getElementById("tfOptions").classList.toggle("hidden", type !== "true_false");
  document.getElementById("shortOptions").classList.toggle("hidden", type !== "short_answer");
}

async function saveQuestion() {
  const alertEl = document.getElementById("qModalAlert");
  const type = document.getElementById("qType").value;
  const text = document.getElementById("qText").value.trim();
  const points = Number(document.getElementById("qPoints").value);

  if (!text) return showAlert(alertEl, "يرجى كتابة نص السؤال.", "error");
  if (!(points > 0)) return showAlert(alertEl, "يرجى تحديد درجة صحيحة أكبر من صفر.", "error");

  let options = null;
  let answerKeyData = null;

  if (type === "multiple_choice") {
    const a = document.getElementById("optA").value.trim();
    const b = document.getElementById("optB").value.trim();
    const c = document.getElementById("optC").value.trim();
    const d = document.getElementById("optD").value.trim();
    if (!a || !b || !c || !d) return showAlert(alertEl, "يرجى تعبئة الاختيارات الأربعة كاملة.", "error");
    options = { a, b, c, d };
    answerKeyData = { examId: examCtx.examId, correctAnswer: document.getElementById("mcCorrect").value };
  } else if (type === "true_false") {
    answerKeyData = { examId: examCtx.examId, correctAnswer: document.getElementById("tfCorrect").value };
  } else if (type === "short_answer") {
    const raw = document.getElementById("acceptableAnswers").value.trim();
    if (!raw) return showAlert(alertEl, "يرجى إدخال إجابة صحيحة واحدة على الأقل.", "error");
    const acceptableAnswers = raw.split(",").map((s) => s.trim()).filter(Boolean);
    answerKeyData = { examId: examCtx.examId, acceptableAnswers };
  } else if (type === "essay") {
    answerKeyData = null; // لا يوجد تصحيح تلقائي للمقالي
  }

  try {
    const questionRef = editingQuestionId
      ? db.collection(COLLECTIONS.QUESTIONS).doc(editingQuestionId)
      : db.collection(COLLECTIONS.QUESTIONS).doc();

    const order = editingQuestionId
      ? examCtx.questions.find((q) => q.id === editingQuestionId).order
      : examCtx.questions.length;

    const questionData = { examId: examCtx.examId, type, text, points, order };
    if (options) questionData.options = options;

    const batch = db.batch();
    batch.set(questionRef, questionData);
    if (answerKeyData) {
      batch.set(db.collection(COLLECTIONS.ANSWER_KEYS).doc(questionRef.id), answerKeyData);
    }
    await batch.commit();

    closeQuestionModal();
    await syncQuestionCount();
    await loadQuestions();
  } catch (err) {
    console.error(err);
    showAlert(alertEl, translateError(err), "error");
  }
}


/* ======================================================================
   3) كتابة الأسئلة دفعة واحدة
   ====================================================================== */

const BULK_SAMPLE = `What is the capital of France?
A) Berlin
B) Paris *
C) Madrid
D) Rome
Points: 2

The sun rises in the west.
TF: false

Write the past tense of "go".
Answer: went

Write a short paragraph about your daily routine.
Essay
Points: 5`;

const BULK_RX = {
  points: /^(?:points?|score|marks?|الدرجة|درجة|الدرجات)\s*[:：=]\s*(\S+)\s*$/i,
  tf: /^(?:tf|true\s*\/\s*false|صح\s*\/\s*خطأ)\s*[:：=]\s*(.+)$/i,
  answer: /^(?:answers?|correct|الإجابة الصحيحة|الإجابة|الاجابة|الإجابات|الاجابات)\s*[:：=]\s*(.+)$/i,
  essay: /^(?:essay|مقالي)$/i,
  option: /^\(?([A-Da-d])[).:]\s*(\S.*)$/,
};

function parseBulkTf(v) {
  const x = String(v).trim().toLowerCase();
  if (["true", "t", "yes", "صح", "صحيح"].includes(x)) return "true";
  if (["false", "f", "no", "خطأ", "خطا"].includes(x)) return "false";
  return null;
}

/**
 * يحوّل النص الحر إلى أسئلة. الأسئلة تُفصل بسطر فارغ.
 * يعيد { questions: [...], errors: [...] } — لا يُضاف شيء إذا وُجدت أخطاء.
 */
function parseBulkQuestions(raw) {
  const text = String(raw || "").replace(/\r\n?/g, "\n").trim();
  const questions = [];
  const errors = [];
  if (!text) return { questions, errors };

  let n = 0;
  text.split(/\n[ \t]*\n/).forEach((block) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    n++;

    const textLines = [];
    const opts = {};
    let correct = null, tf = null, answers = null, essay = false, points = null;
    let started = false, problem = null;

    lines.forEach((line, i) => {
      if (problem) return;
      if (i > 0) {
        let m;
        if ((m = line.match(BULK_RX.points))) { points = Number(m[1]); started = true; return; }
        if ((m = line.match(BULK_RX.tf))) {
          tf = parseBulkTf(m[1]);
          if (tf === null) problem = `قيمة صح/خطأ غير مفهومة "${m[1].trim()}" — اكتب true أو false.`;
          started = true; return;
        }
        if ((m = line.match(BULK_RX.answer))) { answers = m[1].trim(); started = true; return; }
        if (BULK_RX.essay.test(line)) { essay = true; started = true; return; }

        let l = line, star = false;
        if (l.startsWith("*")) { star = true; l = l.replace(/^\*+\s*/, ""); }
        if ((m = l.match(BULK_RX.option))) {
          let body = m[2].trim();
          if (/\*+\s*$/.test(body)) { star = true; body = body.replace(/\s*\*+\s*$/, "").trim(); }
          const key = m[1].toLowerCase();
          if (opts[key] !== undefined) { problem = `الاختيار ${key.toUpperCase()} مكرر.`; return; }
          if (!body) { problem = `الاختيار ${key.toUpperCase()} فارغ.`; return; }
          opts[key] = body;
          started = true;
          if (star) {
            if (correct && correct !== key) { problem = "تم وضع علامة * على أكثر من اختيار."; return; }
            correct = key;
          }
          return;
        }
        if (started) { problem = `سطر غير مفهوم: "${line.slice(0, 40)}"`; return; }
      }
      textLines.push(line);
    });

    const label = `السؤال ${n} ("${lines[0].slice(0, 28)}${lines[0].length > 28 ? "…" : ""}")`;
    const fail = (msg) => errors.push(`${label}: ${msg}`);
    if (problem) return fail(problem);

    // إزالة الترقيم من بداية السؤال: "1." أو "2)" أو "Q3:"
    textLines[0] = textLines[0]
      .replace(/^Q(?:uestion)?\s*\d*\s*[:.)]\s*/i, "")
      .replace(/^\d+\s*[.)]\s*(?=\D)/, "");
    const qText = textLines.join("\n").trim();
    if (!qText) return fail("نص السؤال فارغ.");

    const hasOpts = Object.keys(opts).length > 0;
    const kinds = [
      hasOpts && "mc",
      tf !== null && "tf",
      !hasOpts && answers !== null && "short",
      essay && "essay",
    ].filter(Boolean);
    if (kinds.length === 0) return fail("لم يتم التعرّف على نوع السؤال. أضف اختيارات A–D، أو TF:، أو Answer:، أو Essay.");
    if (kinds.length > 1) return fail("لا يمكن الجمع بين أكثر من نوع في سؤال واحد.");

    if (points !== null && !(points > 0)) return fail("الدرجة يجب أن تكون رقمًا أكبر من صفر.");
    const q = { type: null, text: qText, points: points === null ? 1 : points };

    if (kinds[0] === "mc") {
      if (!["a", "b", "c", "d"].every((k) => opts[k])) return fail("يجب كتابة أربعة اختيارات A و B و C و D.");
      if (answers !== null) {
        const letter = answers.trim().replace(/[).:]$/, "").toLowerCase();
        if (!/^[a-d]$/.test(letter)) return fail("الإجابة الصحيحة يجب أن تكون حرفًا واحدًا من A إلى D.");
        if (correct && correct !== letter) return fail("علامة * لا تتطابق مع سطر Answer.");
        correct = letter;
      }
      if (!correct) return fail("حدّد الاختيار الصحيح بعلامة * أو بسطر Answer: B.");
      q.type = "multiple_choice";
      q.options = { a: opts.a, b: opts.b, c: opts.c, d: opts.d };
      q.correct = correct;
    } else if (kinds[0] === "tf") {
      q.type = "true_false";
      q.correct = tf;
    } else if (kinds[0] === "short") {
      const acceptable = answers.split(/[,،]/).map((x) => x.trim()).filter(Boolean);
      if (!acceptable.length) return fail("أدخل إجابة صحيحة واحدة على الأقل.");
      q.type = "short_answer";
      q.acceptable = acceptable;
    } else {
      q.type = "essay";
    }
    questions.push(q);
  });

  return { questions, errors };
}

function describeBulkCorrect(q) {
  // يعيد HTML جاهزًا؛ <bdi> يمنع اختلاط اتجاه الحروف اللاتينية داخل السطر العربي
  const v = (t) => `<bdi>${escapeHtml(t)}</bdi>`;
  if (q.type === "multiple_choice") return `الصحيح: ${v(q.correct.toUpperCase())}`;
  if (q.type === "true_false") return `الصحيح: ${v(q.correct === "true" ? "True" : "False")}`;
  if (q.type === "short_answer") return `مقبول: ${v(q.acceptable.join(" / "))}`;
  return "تصحيح يدوي";
}

async function saveBulkQuestions(list) {
  const start = examCtx.questions.length;
  const batch = db.batch();
  list.forEach((q, i) => {
    const ref = db.collection(COLLECTIONS.QUESTIONS).doc();
    const data = { examId: examCtx.examId, type: q.type, text: q.text, points: q.points, order: start + i };
    if (q.type === "multiple_choice") data.options = q.options;
    batch.set(ref, data);

    let key = null;
    if (q.type === "multiple_choice" || q.type === "true_false") key = { examId: examCtx.examId, correctAnswer: q.correct };
    else if (q.type === "short_answer") key = { examId: examCtx.examId, acceptableAnswers: q.acceptable };
    if (key) batch.set(db.collection(COLLECTIONS.ANSWER_KEYS).doc(ref.id), key);
  });
  await batch.commit();
  await syncQuestionCount();
  await loadQuestions();
}

function wireBulkModal() {
  const openBtn = document.getElementById("bulkQuestionsBtn");
  if (!openBtn) return;
  const modal = document.getElementById("bulkModal");
  const input = document.getElementById("bulkText");
  const preview = document.getElementById("bulkPreview");
  const alertEl = document.getElementById("bulkAlert");
  const addBtn = document.getElementById("bulkAddBtn");
  let parsed = [];

  function render() {
    const { questions, errors } = parseBulkQuestions(input.value);
    parsed = errors.length ? [] : questions;
    addBtn.disabled = parsed.length === 0;
    addBtn.textContent = parsed.length ? `إضافة الأسئلة (${parsed.length})` : "إضافة الأسئلة";

    let html = "";
    if (errors.length) {
      html += `<div class="alert alert-error"><div>يوجد ${errors.length === 1 ? "خطأ" : "أخطاء"} يجب تصحيحها قبل الإضافة:</div>` +
        errors.map((e) => `<div class="small mt-8">• ${escapeHtml(e)}</div>`).join("") + `</div>`;
    }
    if (questions.length) {
      const total = questions.reduce((sum, q) => sum + q.points, 0);
      html += `<div class="muted mt-8">عدد الأسئلة: ${questions.length} — مجموع الدرجات: ${total}</div>`;
      html += questions.map((q, i) => `
        <div class="q-card" style="padding:10px 12px; margin:8px 0;">
          <span class="badge badge-progress">${typeLabels[q.type]}</span>
          <span class="muted small">— ${q.points} — ${describeBulkCorrect(q)}</span>
          <div class="ltr small" style="direction:ltr; text-align:left; margin-top:6px;">${i + 1}. ${escapeHtml(q.text)}</div>
        </div>`).join("");
    }
    preview.innerHTML = html;
  }

  openBtn.addEventListener("click", () => {
    input.value = "";
    clearAlert(alertEl);
    render();
    modal.classList.remove("hidden");
    input.focus();
  });
  input.addEventListener("input", render);
  document.getElementById("bulkSampleBtn").addEventListener("click", () => { input.value = BULK_SAMPLE; render(); });
  document.getElementById("bulkCancelBtn").addEventListener("click", () => modal.classList.add("hidden"));

  addBtn.addEventListener("click", async () => {
    if (!parsed.length) return;
    addBtn.disabled = true;
    addBtn.textContent = "جاري الإضافة...";
    try {
      await saveBulkQuestions(parsed);
      modal.classList.add("hidden");
    } catch (err) {
      console.error(err);
      showAlert(alertEl, translateError(err), "error");
      render();
    }
  });
}

/* ======================================================================
   نقطة التشغيل — يجب أن تبقى في آخر الملف.
   guardTeacherPage تستدعي الدالة فورًا (بدون انتظار)، فلو كانت في أعلى الملف
   لحاولت initCreateExamPage استخدام examCtx قبل تعريفه (خطأ TDZ) وتعطّلت الصفحة.
   ====================================================================== */
guardTeacherPage((teacher) => {
  currentTeacher = teacher;
  const chip = document.getElementById("userChip");
  if (chip) chip.textContent = `${teacher.name || teacher.email} 👋`;

  if (document.getElementById("statGrid")) initDashboardPage();
  if (document.getElementById("examForm")) initCreateExamPage();
});
