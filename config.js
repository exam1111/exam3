/* الخيار الأول: Firebase (Firestore) — الصق هنا إعدادات تطبيق الويب من لوحة Firebase (انظر SETUP.md) */
window.FIREBASE_CONFIG = {
  databaseURL: "https://exam-dab4c-default-rtdb.firebaseio.com",   // لـ Realtime Database: مثال https://اسم-المشروع-default-rtdb.firebaseio.com
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

/* الخيار الثاني (اختياري بدل Firebase): Supabase */
window.SUPABASE_URL = "";
window.SUPABASE_ANON_KEY = "";

/* إن تُركت كل القيم فارغة تبقى البيانات على الجهاز نفسه فقط. */
