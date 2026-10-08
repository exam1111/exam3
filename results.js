/**
 * results.js
 * صفحة نتائج الامتحان الخاصة بالأستاذ: قائمة الطلاب، تصحيح تلقائي
 * للأسئلة الموضوعية، وتصحيح يدوي للأسئلة المقالية.
 */

let rctx = {
  examId: null,
  exam: null,
  questions: [],
  answerKeys: {}, // questionId -> answerKey data
  attempts: [],
  violationsByAttempt: {}, // attemptId -> [violation, ...] مرتّبة زمنيًا
};

guardTeacherPage(async (teacher) => {
  const chip = document.getElementById("userChip");
  if (chip) chip.textContent = `${teacher.name || teacher.email} 👋`;

  const params = new URLSearchParams(window.location.search);
  rctx.examId = params.get("exam");
  const alertBox = document.getElementById("alertBox");

  if (!rctx.examId) {
    showAlert(alertBox, "لم يتم تحديد امتحان.", "error");
    return;
  }

  try {
    const examDoc = await db.collection(COLLECTIONS.EXAMS).doc(rctx.examId).get();
    if (!examDoc.exists || examDoc.data().teacherId !== teacher.uid) {
      showAlert(alertBox, "لا تملك صلاحية الوصول لنتائج هذا الامتحان.", "error");
      return;
    }
    rctx.exam = examDoc.data();
    document.getElementById("examTitleHeader").textContent = `نتائج: ${rctx.exam.title}`;

    const qSnap = await db.collection(COLLECTIONS.QUESTIONS).where("examId", "==", rctx.examId).orderBy("order").get();
    rctx.questions = qSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const keysSnap = await db
      .collection(COLLECTIONS.ANSWER_KEYS)
      .where("examId", "==", rctx.examId)
      .get(); // القراءة مسموحة للأستاذ صاحب الامتحان فقط عبر القواعد
    keysSnap.forEach((d) => (rctx.answerKeys[d.id] = d.data()));

    await loadAttempts();

    document.getElementById("autoGradeBtn").addEventListener("click", runAutoGrade);
    document.getElementById("backToListBtn").addEventListener("click", showListView);
  } catch (err) {
    console.error(err);
    showAlert(alertBox, translateError(err), "error");
  }
});

async function loadAttempts() {
  const snap = await db.collection(COLLECTIONS.ATTEMPTS).where("examId", "==", rctx.examId).get();
  rctx.attempts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  rctx.attempts.sort((a, b) => tsMsSafe(b.startedAt) - tsMsSafe(a.startedAt));

  // سجل المخالفات (خروج من الامتحان، نسخ/لصق، محاولة دخول بعد التسليم...)
  const vSnap = await db.collection(COLLECTIONS.VIOLATIONS).where("examId", "==", rctx.examId).get();
  rctx.violationsByAttempt = {};
  vSnap.docs.forEach((d) => {
    const v = { id: d.id, ...d.data() };
    (rctx.violationsByAttempt[v.attemptId] = rctx.violationsByAttempt[v.attemptId] || []).push(v);
  });
  Object.values(rctx.violationsByAttempt).forEach((list) => list.sort((a, b) => tsMsSafe(a.timestamp) - tsMsSafe(b.timestamp)));

  renderStats();
  renderAttemptsTable();
}

function violationTotal(attempt) {
  const logged = (rctx.violationsByAttempt[attempt.id] || []).length;
  return Math.max(Number(attempt.violationCount) || 0, logged);
}

function tsMsSafe(v) {
  const ms = toMs(v);
  return isNaN(ms) ? 0 : ms;
}

function renderStats() {
  const total = rctx.attempts.length;
  const graded = rctx.attempts.filter((a) => a.status === "graded").length;
  const pending = rctx.attempts.filter((a) => a.status !== "graded").length;
  const gradedOnes = rctx.attempts.filter((a) => a.status === "graded" && a.maxScore > 0);
  const avg = gradedOnes.length
    ? Math.round((gradedOnes.reduce((s, a) => s + a.totalScore / a.maxScore, 0) / gradedOnes.length) * 100)
    : 0;
  const nums = document.querySelectorAll("#resultsStatGrid .num");
  const values = [total, graded, pending, gradedOnes.length ? `${avg}%` : "—"];
  nums.forEach((el, i) => (el.textContent = values[i]));
}

function renderAttemptsTable() {
  const tbody = document.getElementById("attemptsTbody");
  if (rctx.attempts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">لم يدخل أي طالب هذا الامتحان بعد.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  rctx.attempts.forEach((attempt) => {
    const tr = document.createElement("tr");
    tr.className = "row-link";
    const scoreLabel =
      attempt.status === "graded"
        ? `${attempt.totalScore} / ${attempt.maxScore}`
        : attempt.status === "submitted"
        ? "بانتظار التصحيح"
        : "—";
    tr.innerHTML = `
      <td>${escapeHtml(attempt.studentName)}</td>
      <td class="ltr">${formatDateTime(attempt.startedAt)}</td>
      <td class="ltr">${attempt.submittedAt ? formatDateTime(attempt.submittedAt) : "—"}</td>
      <td>${scoreLabel}</td>
      <td>${violationTotal(attempt) > 0 ? `<span class="viol-badge">${violationTotal(attempt)}</span>` : "0"}</td>
      <td>${attemptStatusBadge(attempt.status)}</td>
    `;
    tr.addEventListener("click", () => showDetailView(attempt.id));
    tbody.appendChild(tr);
  });
}

function attemptStatusBadge(status) {
  const map = {
    in_progress: ["جارٍ", "progress"],
    submitted: ["تم التسليم", "submitted"],
    graded: ["تم التصحيح", "graded"],
  };
  const [label, cls] = map[status] || [status, "draft"];
  return `<span class="badge badge-${cls}">${label}</span>`;
}

/* ---------------------- التصحيح التلقائي ---------------------- */

function isCorrectObjective(question, answerValue) {
  const key = rctx.answerKeys[question.id];
  if (!key) return false;
  if (question.type === "multiple_choice" || question.type === "true_false") {
    return answerValue === key.correctAnswer;
  }
  if (question.type === "short_answer") {
    const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
    return (key.acceptableAnswers || []).some((a) => norm(a) === norm(answerValue));
  }
  return false;
}

async function runAutoGrade() {
  const btn = document.getElementById("autoGradeBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> جاري التصحيح...';
  try {
    for (const attempt of rctx.attempts) {
      if (attempt.status === "in_progress") continue; // لا نصحح محاولة لم تُسلَّم بعد
      const answersSnap = await db.collection(COLLECTIONS.ANSWERS).where("attemptId", "==", attempt.id).get();
      const batch = db.batch();
      let touched = false;
      answersSnap.forEach((doc) => {
        const answer = doc.data();
        const question = rctx.questions.find((q) => q.id === answer.questionId);
        if (!question || question.type === "essay") return;
        const correct = isCorrectObjective(question, answer.answerValue);
        batch.update(doc.ref, { autoScore: correct ? question.points : 0, isCorrect: correct });
        touched = true;
      });
      if (touched) await batch.commit();
      await recomputeAttemptScore(attempt.id);
    }
    await loadAttempts();
    showAlert(document.getElementById("alertBox"), "تم تصحيح جميع الأسئلة الموضوعية بنجاح.", "success");
  } catch (err) {
    console.error(err);
    showAlert(document.getElementById("alertBox"), translateError(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "تصحيح تلقائي للأسئلة الموضوعية";
  }
}

async function recomputeAttemptScore(attemptId) {
  const answersSnap = await db.collection(COLLECTIONS.ANSWERS).where("attemptId", "==", attemptId).get();
  const answersByQ = {};
  answersSnap.forEach((d) => (answersByQ[d.data().questionId] = d.data()));

  let total = 0;
  let pendingEssay = 0;
  rctx.questions.forEach((q) => {
    const ans = answersByQ[q.id];
    if (q.type === "essay") {
      if (ans && typeof ans.teacherScore === "number") total += ans.teacherScore;
      else pendingEssay += 1;
    } else {
      if (ans && typeof ans.autoScore === "number") total += ans.autoScore;
      else pendingEssay += 0; // موضوعي بدون تصحيح بعد يُحتسب صفرًا مؤقتًا وليس "معلقًا"
    }
  });

  const attemptRef = db.collection(COLLECTIONS.ATTEMPTS).doc(attemptId);
  const newStatus = pendingEssay === 0 ? "graded" : "submitted";
  await attemptRef.update({
    totalScore: total,
    status: newStatus,
  });
}

/* ---------------------- عرض تفاصيل محاولة طالب ---------------------- */

function showListView() {
  document.getElementById("listView").classList.remove("hidden");
  document.getElementById("detailView").classList.add("hidden");
}

async function showDetailView(attemptId) {
  const attempt = rctx.attempts.find((a) => a.id === attemptId);
  document.getElementById("listView").classList.add("hidden");
  document.getElementById("detailView").classList.remove("hidden");
  document.getElementById("detailStudentName").textContent = attempt.studentName;
  document.getElementById("detailMeta").textContent =
    `دخل: ${formatDateTime(attempt.startedAt)} — سلّم: ${attempt.submittedAt ? formatDateTime(attempt.submittedAt) : "لم يسلّم بعد"} — مخالفات: ${violationTotal(attempt)}`;
  renderViolationLog(attempt);

  const answersSnap = await db.collection(COLLECTIONS.ANSWERS).where("attemptId", "==", attemptId).get();
  const answersByQ = {};
  answersSnap.forEach((d) => (answersByQ[d.data().questionId] = { id: d.id, ...d.data() }));

  const container = document.getElementById("detailQuestions");
  container.innerHTML = "";

  rctx.questions.forEach((q, index) => {
    const answer = answersByQ[q.id];
    const key = rctx.answerKeys[q.id];
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="muted small">السؤال ${index + 1} — ${typeLabelAr(q.type)} — (${q.points} ${q.points === 1 ? "درجة" : "درجات"})</div>
      <div class="ltr mt-8" style="direction:ltr; text-align:left; font-weight:500;">${escapeHtml(q.text)}</div>
      <div class="mt-16"><strong>إجابة الطالب:</strong> <span class="ltr">${formatAnswerForDisplay(q, answer)}</span></div>
      ${q.type !== "essay" ? `<div class="mt-8"><strong>الإجابة الصحيحة (تظهر للأستاذ فقط):</strong> <span class="ltr">${formatCorrectAnswer(q, key)}</span></div>` : ""}
      <div class="mt-8" id="score-row-${q.id}"></div>
    `;
    const scoreRow = card.querySelector(`#score-row-${q.id}`);
    if (q.type === "essay") {
      const current = answer?.teacherScore ?? "";
      scoreRow.innerHTML = `
        <div class="form-row" style="align-items:flex-end;">
          <div class="field" style="max-width:140px;">
            <label>الدرجة (من ${q.points})</label>
            <input type="number" min="0" max="${q.points}" step="0.5" id="essayScore-${q.id}" value="${current}" />
          </div>
          <button class="btn btn-primary btn-sm" data-act="save-essay" data-qid="${q.id}">حفظ الدرجة</button>
        </div>
      `;
      scoreRow.querySelector('[data-act="save-essay"]').addEventListener("click", () => saveEssayScore(attemptId, q, answer));
    } else {
      const score = answer && typeof answer.autoScore === "number" ? answer.autoScore : "لم يُصحَّح بعد";
      scoreRow.innerHTML = `<strong>الدرجة:</strong> ${score} ${typeof score === "number" ? `/ ${q.points}` : ""}`;
    }
    container.appendChild(card);
  });
}

function renderViolationLog(attempt) {
  const box = document.getElementById("detailViolations");
  const list = rctx.violationsByAttempt[attempt.id] || [];
  if (list.length === 0) {
    box.innerHTML = `<div class="card"><h3 class="mb-0">سجل المخالفات</h3><p class="muted small mb-0 mt-8">لا توجد مخالفات مسجَّلة لهذا الطالب.</p></div>`;
    return;
  }
  const items = list
    .map((v) => {
      const extras = [];
      if (v.durationSec) extras.push(`مدة الغياب: ${formatCountdown(v.durationSec)}`);
      if (v.attemptedName) extras.push(`الاسم المُدخل: ${escapeHtml(v.attemptedName)}${v.differentName ? " (اسم مختلف)" : ""}`);
      return `<li>
        <span><strong>${escapeHtml(violationLabelAr(v.type))}</strong>${extras.length ? `<br><span class="muted small">${extras.join(" — ")}</span>` : ""}</span>
        <span class="when ltr">${formatDateTimeSec(v.timestamp)}</span>
      </li>`;
    })
    .join("");
  box.innerHTML = `<div class="card"><h3 class="mb-0">سجل المخالفات (${list.length})</h3><ul class="viol-list">${items}</ul></div>`;
}

function typeLabelAr(type) {
  return { multiple_choice: "اختيار من متعدد", true_false: "صح / خطأ", short_answer: "إجابة قصيرة", essay: "مقالي" }[type] || type;
}

function formatAnswerForDisplay(question, answer) {
  if (!answer || answer.answerValue === undefined || answer.answerValue === "") return "لم يُجب";
  if (question.type === "multiple_choice") {
    const letter = answer.answerValue;
    const text = question.options?.[letter] || "";
    return `${letter.toUpperCase()} — ${escapeHtml(text)}`;
  }
  if (question.type === "true_false") {
    return answer.answerValue === "true" ? "True" : "False";
  }
  return escapeHtml(answer.answerValue);
}

function formatCorrectAnswer(question, key) {
  if (!key) return "—";
  if (question.type === "multiple_choice") {
    const letter = key.correctAnswer;
    return `${letter.toUpperCase()} — ${escapeHtml(question.options?.[letter] || "")}`;
  }
  if (question.type === "true_false") {
    return key.correctAnswer === "true" ? "True" : "False";
  }
  if (question.type === "short_answer") {
    return (key.acceptableAnswers || []).join(" / ");
  }
  return "—";
}

async function saveEssayScore(attemptId, question, existingAnswer) {
  const input = document.getElementById(`essayScore-${question.id}`);
  let score = Number(input.value);
  if (isNaN(score) || score < 0) score = 0;
  if (score > question.points) score = question.points;
  input.value = score;

  const answerId = `${attemptId}_${question.id}`;
  await db.collection(COLLECTIONS.ANSWERS).doc(answerId).set(
    {
      attemptId,
      examId: rctx.examId,
      questionId: question.id,
      studentUid: existingAnswer?.studentUid || null,
      answerValue: existingAnswer?.answerValue || "",
      teacherScore: score,
    },
    { merge: true }
  );

  await recomputeAttemptScore(attemptId);
  await loadAttempts();
  showAlert(document.getElementById("alertBox"), "تم حفظ درجة السؤال المقالي.", "success");
  showDetailView(attemptId);
}
