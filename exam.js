/**
 * exam.js
 * الملف المسؤول عن كل ما يحدث داخل صفحة الامتحان (exam.html):
 *  - إنشاء/استئناف محاولة واحدة فقط لكل طالب لكل امتحان
 *  - عرض الأسئلة (بدون أي إجابات صحيحة على الإطلاق)
 *  - مؤقّت معتمد على وقت بدء المحاولة المخزَّن في الخادم (serverTimestamp)
 *  - حفظ إجابات الطالب أولًا بأول
 *  - تسليم تلقائي عند انتهاء الوقت + تسليم يدوي
 *  - مراقبة سلوك الطالب (تبديل تبويب/فقدان تركيز/نسخ/لصق...) وتسجيل المخالفات
 *
 * ملاحظة أمنية جوهرية: هذا الملف لا يحمّل ولا يعرض إطلاقًا حقل
 * correctAnswer. الإجابات الصحيحة مخزّنة في Collection منفصلة تمامًا
 * (answerKeys) وقواعد الأمان تمنع أي مستخدم غير الأستاذ من قراءتها.
 */

const els = {
  loading: document.getElementById("loadingState"),
  blocked: document.getElementById("blockedState"),
  blockedTitle: document.getElementById("blockedTitle"),
  blockedMessage: document.getElementById("blockedMessage"),
  shell: document.getElementById("examShell"),
  submitted: document.getElementById("submittedState"),
  submittedMessage: document.getElementById("submittedMessage"),
  examTitle: document.getElementById("examTitle"),
  examStudentName: document.getElementById("examStudentName"),
  timerDisplay: document.getElementById("timerDisplay"),
  questionsContainer: document.getElementById("questionsContainer"),
  submitBtn: document.getElementById("submitExamBtn"),
  confirmModal: document.getElementById("confirmSubmitModal"),
  cancelSubmitBtn: document.getElementById("cancelSubmitBtn"),
  confirmSubmitBtn: document.getElementById("confirmSubmitBtn"),
  violationToast: document.getElementById("violationToast"),
  violationBadge: document.getElementById("violationBadge"),
};

let state = {
  examId: null,
  exam: null,
  uid: null,
  attemptId: null,
  attempt: null,
  questions: [],
  answers: {}, // questionId -> answerValue (محليًا للعرض فقط)
  endsAt: null, // Date موثوق بها (مبنية على startedAt القادم من الخادم)
  timerInterval: null,
  autoSubmitTriggered: false,
  saveTimers: {}, // questionId -> setTimeout handle لتأخير الحفظ (debounce)
  lastViolationAt: {}, // type -> timestamp لمنع تكرار تسجيل نفس المخالفة بسرعة
  violationCount: 0, // عدّاد معروض للطالب
  away: false, // هل الطالب خارج صفحة الامتحان الآن؟ (لتسجيل الخروج مرة واحدة فقط)
  awayAt: 0,
  awayViolation: null, // { ref, ready } لتحديث مدة الغياب عند العودة
};

function showBlocked(title, message) {
  els.loading.classList.add("hidden");
  els.shell.classList.add("hidden");
  els.blocked.classList.remove("hidden");
  els.blockedTitle.textContent = title;
  els.blockedMessage.textContent = message;
}

function showSubmitted(message) {
  stopTimer();
  detachMonitoring();
  els.loading.classList.add("hidden");
  els.shell.classList.add("hidden");
  els.blocked.classList.add("hidden");
  els.submitted.classList.remove("hidden");
  if (message) els.submittedMessage.textContent = message;
}

/* ============================ التشغيل الرئيسي ============================ */

(async function main() {
  try {
    const params = new URLSearchParams(window.location.search);
    state.examId = params.get("exam");
    if (!state.examId) {
      showBlocked("رابط غير صالح", "لا يوجد رمز امتحان في هذا الرابط.");
      return;
    }

    await guardStudentSession();
    state.uid = auth.currentUser.uid;

    const [studentDoc, examDoc] = await Promise.all([
      db.collection(COLLECTIONS.STUDENTS).doc(state.uid).get(),
      db.collection(COLLECTIONS.EXAMS).doc(state.examId).get(),
    ]);

    if (!studentDoc.exists) {
      showBlocked("لم يتم التعرّف عليك", "يرجى الدخول أولًا من صفحة دخول الطالب.");
      return;
    }
    if (!examDoc.exists) {
      showBlocked("الامتحان غير موجود", "تحقق من الرابط أو رمز الامتحان مع الأستاذ.");
      return;
    }

    const studentName = studentDoc.data().fullName;
    state.exam = examDoc.data();
    state.attemptId = `${state.examId}_${state.uid}`;

    els.examTitle.textContent = state.exam.title;
    els.examStudentName.textContent = studentName;

    const attemptRef = db.collection(COLLECTIONS.ATTEMPTS).doc(state.attemptId);
    let attemptSnap = await attemptRef.get();
    const isResume = attemptSnap.exists; // هل هذه عودة لمحاولة قيد التنفيذ؟

    if (!attemptSnap.exists) {
      // لا توجد محاولة سابقة: تحقّق من نافذة الامتحان قبل إنشاء محاولة جديدة
      const windowCheck = validateExamWindow(state.exam);
      if (!windowCheck.ok) {
        showBlocked("لا يمكن بدء الامتحان", windowCheck.message);
        return;
      }

      const maxScore = await computeMaxScore(state.examId);

      const newAttempt = {
        examId: state.examId,
        studentUid: state.uid,
        studentName,
        studentNameNormalized: normalizeName(studentName),
        status: "in_progress",
        startedAt: serverTimestamp(),
        submittedAt: null,
        lastActivityAt: serverTimestamp(),
        violationCount: 0,
        totalScore: 0,
        maxScore,
      };

      try {
        // rules تمنع الكتابة إذا كان هناك مستند موجود مسبقًا لنفس المعرّف،
        // وهذا هو الضمان الحقيقي لمحاولة واحدة فقط (وليس هذا الشرط في JS).
        await attemptRef.set(newAttempt);
      } catch (err) {
        if (err.code === "permission-denied") {
          // على الأغلب حدث تسابق (Race) وتم إنشاء المحاولة للتو من تبويب آخر
          attemptSnap = await attemptRef.get();
          if (!attemptSnap.exists) {
            showBlocked("تعذّر بدء الامتحان", "حدثت مشكلة أثناء إنشاء محاولتك، أعد تحميل الصفحة.");
            return;
          }
        } else {
          throw err;
        }
      }
      attemptSnap = await attemptRef.get();
    }

    state.attempt = attemptSnap.data();

    if (state.attempt.status === "submitted" || state.attempt.status === "graded") {
      showBlocked("لا يمكنك دخول هذا الامتحان مرة أخرى", "لقد سلّمت هذا الامتحان مسبقًا، ولا يمكنك الدخول إليه ثانيةً حتى لو غيّرت الاسم.");
      return;
    }

    // احسب موعد الانتهاء الموثوق بناءً على startedAt القادم من الخادم
    const startedAtMs = toMs(state.attempt.startedAt);
    const durationMs = state.exam.durationMinutes * 60 * 1000;
    const examEndMs = toMs(state.exam.endAt);
    state.endsAt = new Date(Math.min(startedAtMs + durationMs, examEndMs));

    if (Date.now() >= state.endsAt.getTime()) {
      // انتهى الوقت فعليًا (مثلًا الطالب أغلق المتصفح وعاد بعد فوات الوقت)
      await finalizeAttempt("TIME_EXPIRED_ON_RETURN");
      showBlocked("انتهى وقت الامتحان", "لقد انتهى الوقت المخصص لهذا الامتحان، وتم تسليمه تلقائيًا.");
      return;
    }

    await loadQuestionsAndAnswers();
    renderQuestions();
    state.violationCount = Number(state.attempt.violationCount) || 0;
    updateViolationBadge();
    attachMonitoring();
    startTimer();

    // العودة لمحاولة قيد التنفيذ تعني أن الطالب غادر الصفحة أو أعاد تحميلها سابقًا
    if (isResume) logViolation("RE_ENTRY");

    els.loading.classList.add("hidden");
    els.shell.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    showBlocked("حدث خطأ", translateError(err));
  }
})();

async function computeMaxScore(examId) {
  const qSnap = await db.collection(COLLECTIONS.QUESTIONS).where("examId", "==", examId).get();
  let total = 0;
  qSnap.forEach((doc) => (total += Number(doc.data().points) || 0));
  return total;
}

async function loadQuestionsAndAnswers() {
  const qSnap = await db
    .collection(COLLECTIONS.QUESTIONS)
    .where("examId", "==", state.examId)
    .orderBy("order")
    .get();
  state.questions = qSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const aSnap = await db.collection(COLLECTIONS.ANSWERS).where("attemptId", "==", state.attemptId).get();
  aSnap.forEach((doc) => {
    const data = doc.data();
    state.answers[data.questionId] = data.answerValue;
  });
}

/* ============================ عرض الأسئلة ============================ */

function renderQuestions() {
  els.questionsContainer.innerHTML = "";
  state.questions.forEach((q, index) => {
    const block = document.createElement("div");
    block.className = "card question-block";
    block.innerHTML = `
      <div class="qn">السؤال ${index + 1} من ${state.questions.length} — (${q.points} ${q.points === 1 ? "درجة" : "درجات"})</div>
      <div class="qtext ltr" style="direction:ltr; text-align:left;">${escapeHtml(q.text)}</div>
      <div class="answer-area" data-qid="${q.id}"></div>
    `;
    const area = block.querySelector(".answer-area");
    area.appendChild(buildAnswerInput(q));
    els.questionsContainer.appendChild(block);
  });
}

function buildAnswerInput(q) {
  const wrap = document.createElement("div");
  const existing = state.answers[q.id];

  if (q.type === "multiple_choice") {
    ["a", "b", "c", "d"].forEach((key) => {
      if (!q.options || !q.options[key]) return;
      const row = document.createElement("label");
      row.className = "choice" + (existing === key ? " selected" : "");
      row.innerHTML = `
        <input type="radio" name="q_${q.id}" value="${key}" ${existing === key ? "checked" : ""} />
        <span class="ltr" style="direction:ltr;">${escapeHtml(q.options[key])}</span>
      `;
      row.querySelector("input").addEventListener("change", () => {
        wrap.querySelectorAll(".choice").forEach((c) => c.classList.remove("selected"));
        row.classList.add("selected");
        saveAnswer(q.id, key);
      });
      wrap.appendChild(row);
    });
  } else if (q.type === "true_false") {
    [
      { key: "true", label: "True" },
      { key: "false", label: "False" },
    ].forEach((opt) => {
      const row = document.createElement("label");
      row.className = "choice" + (existing === opt.key ? " selected" : "");
      row.innerHTML = `
        <input type="radio" name="q_${q.id}" value="${opt.key}" ${existing === opt.key ? "checked" : ""} />
        <span class="ltr" style="direction:ltr;">${opt.label}</span>
      `;
      row.querySelector("input").addEventListener("change", () => {
        wrap.querySelectorAll(".choice").forEach((c) => c.classList.remove("selected"));
        row.classList.add("selected");
        saveAnswer(q.id, opt.key);
      });
      wrap.appendChild(row);
    });
  } else if (q.type === "short_answer") {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ltr";
    input.placeholder = "Your answer";
    input.value = existing || "";
    input.addEventListener("input", () => debouncedSave(q.id, input.value));
    wrap.appendChild(input);
  } else if (q.type === "essay") {
    const textarea = document.createElement("textarea");
    textarea.className = "ltr";
    textarea.rows = 5;
    textarea.placeholder = "Write your answer here...";
    textarea.value = existing || "";
    textarea.addEventListener("input", () => debouncedSave(q.id, textarea.value));
    wrap.appendChild(textarea);
  }
  return wrap;
}

/* ============================ حفظ الإجابات ============================ */

function debouncedSave(questionId, value) {
  state.answers[questionId] = value;
  clearTimeout(state.saveTimers[questionId]);
  state.saveTimers[questionId] = setTimeout(() => saveAnswer(questionId, value), 500);
}

async function saveAnswer(questionId, value) {
  state.answers[questionId] = value;
  if (state.attempt.status !== "in_progress") return; // لن تُقبل الكتابة من الخادم بعد الآن
  const answerId = `${state.attemptId}_${questionId}`;
  try {
    await db.collection(COLLECTIONS.ANSWERS).doc(answerId).set(
      {
        attemptId: state.attemptId,
        examId: state.examId,
        questionId,
        studentUid: state.uid,
        answerValue: value,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    await db.collection(COLLECTIONS.ATTEMPTS).doc(state.attemptId).update({ lastActivityAt: serverTimestamp() });
  } catch (err) {
    console.error("فشل حفظ الإجابة", err);
    // لا نوقف الطالب، لكن نعرض تنبيهًا بسيطًا كي يعرف أن الحفظ لم يكتمل
    flashToast("تعذّر حفظ إجابتك الأخيرة، تحقق من اتصال الإنترنت.");
  }
}

/* ============================ المؤقّت ============================ */

function startTimer() {
  updateTimerDisplay();
  state.timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
  clearInterval(state.timerInterval);
}

function updateTimerDisplay() {
  const remainingMs = state.endsAt.getTime() - Date.now();
  const remainingSec = Math.floor(remainingMs / 1000);
  els.timerDisplay.textContent = formatCountdown(remainingSec);
  if (remainingSec <= 60) els.timerDisplay.classList.add("danger");
  if (remainingSec <= 0 && !state.autoSubmitTriggered) {
    state.autoSubmitTriggered = true;
    finalizeAttempt("TIME_EXPIRED").then(() =>
      showSubmitted("انتهى الوقت المخصص للامتحان، تم تسليم إجاباتك تلقائيًا.")
    );
  }
}

/* ============================ التسليم ============================ */

els.submitBtn.addEventListener("click", () => {
  els.confirmModal.classList.remove("hidden");
});
els.cancelSubmitBtn.addEventListener("click", () => {
  els.confirmModal.classList.add("hidden");
});
els.confirmSubmitBtn.addEventListener("click", async () => {
  els.confirmModal.classList.add("hidden");
  els.submitBtn.disabled = true;
  els.submitBtn.textContent = "جاري التسليم...";
  await finalizeAttempt("MANUAL");
  showSubmitted();
});

async function finalizeAttempt(reason) {
  if (state.attempt.status !== "in_progress") return;
  try {
    await db.collection(COLLECTIONS.ATTEMPTS).doc(state.attemptId).update({
      status: "submitted",
      submittedAt: serverTimestamp(),
      submitReason: reason,
    });
    state.attempt.status = "submitted";
  } catch (err) {
    console.error("فشل تسليم الامتحان", err);
  }
}

/* ============================ المراقبة وتسجيل المخالفات ============================ */

function attachMonitoring() {
  applyAntiCheatUiRestrictions(document);

  // الخروج من الصفحة: يُسجَّل مرة واحدة لكل "غياب" مع قياس مدة الغياب عند العودة
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focus", onReturn);
  window.addEventListener("pageshow", onReturn);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pagehide", onPageHide);

  // أفعال أخرى
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCopy);
  document.addEventListener("paste", onPaste);
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("keydown", onKeyDown);
}

function detachMonitoring() {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("blur", onWindowBlur);
  window.removeEventListener("focus", onReturn);
  window.removeEventListener("pageshow", onReturn);
  window.removeEventListener("beforeunload", onBeforeUnload);
  window.removeEventListener("pagehide", onPageHide);
  document.removeEventListener("copy", onCopy);
  document.removeEventListener("cut", onCopy);
  document.removeEventListener("paste", onPaste);
  document.removeEventListener("contextmenu", onContextMenu);
  document.removeEventListener("keydown", onKeyDown);
}

function onCopy() { logViolation("COPY_ATTEMPT"); }
function onPaste() { logViolation("PASTE_ATTEMPT"); }
function onContextMenu() { logViolation("RIGHT_CLICK"); }

function onKeyDown(e) {
  const key = (e.key || "").toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const blockedCombo = mod && ["p", "u", "s"].includes(key);
  const devTools = e.key === "F12" || (mod && e.shiftKey && ["i", "j", "c"].includes(key));
  if (blockedCombo || devTools) logViolation("SHORTCUT_BLOCKED");
}

/** بداية غياب: يُسجَّل مرة واحدة حتى لو أطلق المتصفح أكثر من حدث (blur + visibilitychange) */
function onLeave(type) {
  if (state.away) return;
  if (!state.attemptId || state.attempt.status !== "in_progress") return;
  state.away = true;
  state.awayAt = Date.now();
  state.awayViolation = logViolation(type, {}, { throttle: false });
  flashToast("تحذير: تم تسجيل خروجك من صفحة الامتحان كمحاولة غش.");
}

/** نهاية الغياب: تُحسب المدة وتُضاف لسجل المخالفة */
function onReturn() {
  if (!state.away) return;
  if (document.hidden || (document.hasFocus && !document.hasFocus())) return;
  const seconds = Math.max(1, Math.round((Date.now() - state.awayAt) / 1000));
  const rec = state.awayViolation;
  state.away = false;
  state.awayViolation = null;
  if (rec) {
    rec.ready
      .then(() => rec.ref.update({ durationSec: seconds }))
      .catch((err) => console.warn("تعذّر تحديث مدة الغياب", err));
  }
  flashToast(`تم تسجيل غيابك عن الامتحان لمدة ${seconds} ثانية.`);
}

function onVisibilityChange() {
  if (document.hidden) onLeave("TAB_SWITCH");
  else onReturn();
}

function onWindowBlur() {
  onLeave("WINDOW_BLUR");
}

function onBeforeUnload(e) {
  // محاولة تسجيل مخالفة قبل مغادرة الصفحة. لا يمكن ضمان اكتمال الطلب
  // لأن المتصفح قد يُنهي الصفحة قبل وصول البيانات للخادم — لذلك تُسجَّل أيضًا
  // مخالفة RE_ENTRY عند عودة الطالب للامتحان، وهي التي يُعتمد عليها فعليًا.
  logViolation("PAGE_UNLOAD_ATTEMPT");
  e.preventDefault();
  e.returnValue = "";
}

function onPageHide() {
  logViolation("PAGE_UNLOAD_ATTEMPT");
}

/**
 * يسجّل مخالفة في قاعدة البيانات ويزيد العدّاد.
 * يُرجع { ref, ready } كي يمكن تحديث المخالفة لاحقًا (مثل مدة الغياب).
 */
function logViolation(type, extra = {}, { throttle = true } = {}) {
  if (!state.attemptId || !state.attempt || state.attempt.status !== "in_progress") return null;

  const now = Date.now();
  if (throttle) {
    const last = state.lastViolationAt[type] || 0;
    if (now - last < 3000) return null; // تجنّب تسجيل نفس المخالفة عشرات المرات في ثوانٍ
    state.lastViolationAt[type] = now;
  }

  const ref = db.collection(COLLECTIONS.VIOLATIONS).doc();
  const ready = ref
    .set({
      attemptId: state.attemptId,
      examId: state.examId,
      studentUid: state.uid,
      type,
      timestamp: serverTimestamp(),
      ...extra,
    })
    .catch((err) => console.warn("تعذّر تسجيل المخالفة", err));

  db.collection(COLLECTIONS.ATTEMPTS)
    .doc(state.attemptId)
    .update({
      violationCount: localIncrement(1),
      lastActivityAt: serverTimestamp(),
    })
    .catch((err) => console.warn("تعذّر تحديث عدّاد المخالفات", err));

  state.violationCount += 1;
  updateViolationBadge();
  return { ref, ready };
}

function updateViolationBadge() {
  if (!els.violationBadge) return;
  const n = state.violationCount;
  els.violationBadge.textContent = `مخالفات مسجَّلة: ${n}`;
  els.violationBadge.classList.toggle("zero", n === 0);
}

function flashToast(message) {
  els.violationToast.textContent = message;
  els.violationToast.classList.remove("hidden");
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => els.violationToast.classList.add("hidden"), 4000);
}
