/* الخيار الأول: Firebase (Firestore) — الصق هنا إعدادات تطبيق الويب من لوحة Firebase (انظر SETUP.md) */
window.FIREBASE_CONFIG = {
  databaseURL: "https://exam-dab4c-default-rtdb.firebaseio.com",   // لـ Realtime Database: مثال https://اسم-المشروع-default-rtdb.firebaseio.com
  apiKey: "AIzaSyAoJ82NmBuqqNWXJKsoSn2WXlBz_-Kse2U",   // مطلوب لتسجيل دخول الأستاذ (Project settings ← General ← Web API Key). مفتاح عام وليس سرًا.
  authDomain: "exam-dab4c.firebaseapp.com",
  projectId: "exam-dab4c",
  storageBucket: "exam-dab4c.firebasestorage.app",
  messagingSenderId: "807518559379",
  appId: "1:807518559379:web:72a32882e400d1377e0166"
};

/* الخيار الثاني (اختياري بدل Firebase): Supabase */
window.SUPABASE_URL = "";
window.SUPABASE_ANON_KEY = "";

/* إن تُركت كل القيم فارغة تبقى البيانات على الجهاز نفسه فقط. */
