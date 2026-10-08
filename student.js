/**
 * student.js
 * منطق صفحة "دخول الطالب" (الانضمام إلى امتحان برمز)
 * ومنطق صفحة "نتيجتي" (student-result.html)
 */

/* ===================== student-login.html ===================== */
(function initJoinPage() {
  const form = document.getElementById("joinForm");
  if (!form) return; // لسنا في صفحة دخول الطالب

  const alertBox = document.getElementById("alertBox");
  const submitBtn = document.getElementById("submitBtn");
  const btnText = document.getElementById("btnText");
  const duplicateModal = document.getElementById("duplicateModal");
  const cancelJoinBtn = document.getElementById("cancelJoinBtn");
  const confirmJoinBtn = document.getElementById("confirmJoinBtn");

  const agreeRules = document.getElementById("agreeRules");

  let pendingJoin = null; // يحمل بيانات الانضمام أثناء انتظار تأكيد المستخدم لتحذير الاسم المكرر

  // زر الدخول يبقى معطّلًا حتى يوافق الطالب على التعليمات
  if (agreeRules) {
    agreeRules.addEventListener("change", () => { submitBtn.disabled = !agreeRules.checked; });
  }

  function setLoading(isLoading, label) {
    submitBtn.disabled = isLoading || (agreeRules ? !agreeRules.checked : false);
    btnText.innerHTML = isLoading ? `<span class="spinner"></span> ${label || "جاري التحقق..."}` : "دخول الامتحان";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alertBox);

    if (agreeRules && !agreeRules.checked) {
      showAlert(alertBox, "يجب الموافقة على التعليمات قبل الدخول للامتحان.", "error");
      return;
    }

    const fullName = document.getElementById("fullName").value.trim().replace(/\s+/g, " ");
    const examCodeRaw = document.getElementById("examCode").value.trim();
    const examCode = examCodeRaw.toUpperCase();

    if (fullName.split(" ").length < 2) {
      showAlert(alertBox, "يرجى إدخال اسمك الكامل (على الأقل اسمين).", "error");
      return;
    }
    if (fullName.split(" ").length < 4) {
      showAlert(alertBox, "يُفضّل إدخال الاسم الرباعي كاملًا لتسهيل توثيق نتيجتك.", "warn");
    }
    if (!examCode) {
      showAlert(alertBox, "يرجى إدخال رمز الامتحان.", "error");
      return;
    }

    setLoading(true);
    try {
      await ensureStudentSession();

      const snap = await db
        .collection(COLLECTIONS.EXAMS)
        .where("examCode", "==", examCode)
        .limit(1)
        .get();

      if (snap.empty) {
        showAlert(alertBox, "رمز الامتحان غير صحيح، تحقق من الرمز وحاول مجددًا.", "error");
        setLoading(false);
        return;
      }

      const examDoc = snap.docs[0];
      const exam = examDoc.data();
      const examId = examDoc.id;

      // (1) هل لهذا الجهاز محاولة سابقة في هذا الامتحان؟ المفتاح هو الجهاز وليس الاسم،
      //     لذلك لا يفيد تغيير الاسم بعد التسليم.
      const uid = auth.currentUser.uid;
      const attemptRef = db.collection(COLLECTIONS.ATTEMPTS).doc(`${examId}_${uid}`);
      const attemptSnap = await attemptRef.get();
      const prevAttempt = attemptSnap.exists ? attemptSnap.data() : null;

      if (prevAttempt && (prevAttempt.status === "submitted" || prevAttempt.status === "graded")) {
        await logReentryAfterSubmit(examId, uid, prevAttempt, fullName);
        showAlert(
          alertBox,
          "لقد سلّمت هذا الامتحان مسبقًا من هذا الجهاز، ولا يمكنك الدخول إليه مرة أخرى حتى لو غيّرت الاسم. تم تسجيل هذه المحاولة.",
          "error"
        );
        setLoading(false);
        return;
      }

      // (2) محاولة قيد التنفيذ: يتابع الطالب بالاسم الأصلي المسجَّل (لا يُسمح بتغييره)
      if (prevAttempt) {
        await upsertStudentProfile(uid, prevAttempt.studentName);
        goToExam(examId);
        return;
      }

      // (3) دخول جديد: تحقق من نافذة الامتحان
      const check = validateExamWindow(exam);
      if (!check.ok) {
        showAlert(alertBox, check.message, "error");
        setLoading(false);
        return;
      }

      await upsertStudentProfile(uid, fullName);

      // فحص توعوي (وليس أمنيًا) عن وجود اسم مطابق لطالب آخر في هذا الامتحان
      const normalized = normalizeName(fullName);
      const dupSnap = await db
        .collection(COLLECTIONS.ATTEMPTS)
        .where("examId", "==", examId)
        .where("studentNameNormalized", "==", normalized)
        .limit(3)
        .get();
      const hasOtherStudentSameName = dupSnap.docs.some((d) => d.data().studentUid !== uid);

      pendingJoin = { examId };

      if (hasOtherStudentSameName) {
        duplicateModal.classList.remove("hidden");
        setLoading(false);
        return;
      }

      goToExam(examId);
    } catch (err) {
      console.error(err);
      showAlert(alertBox, translateError(err), "error");
      setLoading(false);
    }
  });

  cancelJoinBtn.addEventListener("click", () => {
    duplicateModal.classList.add("hidden");
    pendingJoin = null;
    setLoading(false);
  });

  confirmJoinBtn.addEventListener("click", () => {
    duplicateModal.classList.add("hidden");
    if (pendingJoin) goToExam(pendingJoin.examId);
  });

  /** يسجّل محاولة الدخول بعد التسليم في سجل مخالفات المحاولة الأصلية ليراها الأستاذ */
  async function logReentryAfterSubmit(examId, uid, prevAttempt, typedName) {
    try {
      const attemptId = `${examId}_${uid}`;
      await db.collection(COLLECTIONS.VIOLATIONS).add({
        attemptId,
        examId,
        studentUid: uid,
        type: "REENTRY_AFTER_SUBMIT",
        attemptedName: typedName,
        differentName: normalizeName(typedName) !== normalizeName(prevAttempt.studentName),
        timestamp: serverTimestamp(),
      });
      await db.collection(COLLECTIONS.ATTEMPTS).doc(attemptId).update({ violationCount: localIncrement(1) });
    } catch (e) {
      console.warn("تعذّر تسجيل محاولة الدخول بعد التسليم", e);
    }
  }

  function goToExam(examId) {
    window.location.href = `exam.html?exam=${encodeURIComponent(examId)}`;
  }
})();

/* ===================== student-result.html ===================== */
(function initStudentResultPage() {
  const root = document.getElementById("resultRoot");
  if (!root) return; // لسنا في صفحة نتيجة الطالب

  (async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      const examId = params.get("exam");
      if (!examId) {
        root.innerHTML = `<div class="alert alert-error">رابط غير صالح.</div>`;
        return;
      }

      await guardStudentSession();
      const uid = auth.currentUser.uid;
      const attemptId = `${examId}_${uid}`;

      const [attemptDoc, examDoc] = await Promise.all([
        db.collection(COLLECTIONS.ATTEMPTS).doc(attemptId).get(),
        db.collection(COLLECTIONS.EXAMS).doc(examId).get(),
      ]);

      if (!attemptDoc.exists || !examDoc.exists) {
        root.innerHTML = `<div class="alert alert-error">لم يتم العثور على نتيجة لهذا الامتحان بعد.</div>`;
        return;
      }

      const attempt = attemptDoc.data();
      const exam = examDoc.data();

      if (attempt.status !== "graded") {
        root.innerHTML = `
          <div class="card text-center">
            <h2>${escapeHtml(exam.title)}</h2>
            <p class="muted">لم يتم تصحيح إجاباتك بشكل نهائي بعد. يرجى مراجعة الأستاذ لاحقًا.</p>
            <span class="badge badge-${attempt.status === "in_progress" ? "progress" : "submitted"}">
              ${examStatusLabel(attempt.status)}
            </span>
          </div>`;
        return;
      }

      const percentage = attempt.maxScore > 0 ? Math.round((attempt.totalScore / attempt.maxScore) * 100) : 0;

      root.innerHTML = `
        <div class="card text-center">
          <h2>${escapeHtml(exam.title)}</h2>
          <p class="muted mb-0">${escapeHtml(attempt.studentName)}</p>
          <div style="margin:26px 0;">
            <div style="font-size:2.4rem; font-weight:800; font-family:'Inter';">
              ${attempt.totalScore} <span class="muted" style="font-size:1.2rem;">/ ${attempt.maxScore}</span>
            </div>
            <div class="muted">النسبة المئوية: ${percentage}%</div>
          </div>
          <span class="badge badge-graded">تم التصحيح</span>
        </div>
        ${exam.allowShowAnswers ? `<p class="muted small text-center mt-16">سمح الأستاذ بمشاهدة الإجابات الصحيحة، لكن هذه الميزة تعرض حاليًا الدرجة فقط.</p>` : ""}
      `;
    } catch (err) {
      console.error(err);
      root.innerHTML = `<div class="alert alert-error">${escapeHtml(translateError(err))}</div>`;
    }
  })();
})();

function examStatusLabel(status) {
  return (
    {
      in_progress: "الامتحان لا يزال جاريًا",
      submitted: "تم التسليم، بانتظار التصحيح",
      graded: "تم التصحيح",
    }[status] || status
  );
}
