# ربط الامتحان بـ Firebase (ليعمل من أي جهاز)

## 1) إنشاء المشروع
1. ادخل https://console.firebase.google.com ← **Add project** وأنشئ مشروعًا.
2. من القائمة **Build ← Firestore Database** اضغط **Create database** واختر أقرب منطقة، ثم ابدأ بـ **Test mode**.
3. من تبويب **Rules** الصق محتوى ملف `firestore.rules` واضغط **Publish**.
   (وضع Test mode ينتهي بعد 30 يومًا، لذلك يجب نشر القواعد هذه.)

## 2) الحصول على إعدادات الموقع
1. **Project settings** (أيقونة الترس) ← تبويب **General**.
2. في **Your apps** اضغط أيقونة الويب `</>` وسجّل تطبيقًا (لا حاجة لتفعيل Hosting).
3. انسخ القيم داخل `firebaseConfig`.

## 3) وضعها في الموقع
افتح `config.js` وضع القيم داخل `window.FIREBASE_CONFIG`.

## 4) الرفع
ارفع كل الملفات إلى GitHub Pages أو أي استضافة، وأنشئ الامتحان **من جديد** (الامتحانات القديمة موجودة في متصفح الجهاز القديم فقط)، ثم افتح الموقع من أي جهاز.

## ملاحظات
- إن كان موقعك على نطاق مخصص أو GitHub Pages فلا حاجة لإضافته في Authorized domains لأن النظام لا يستخدم Firebase Auth.
- قواعد Firestore مفتوحة (قراءة/كتابة للجميع) لأن النظام لا يستخدم تسجيل دخول Firebase، أي أن طالبًا متمرسًا يمكنه نظريًا رؤية مفاتيح الإجابات. مناسب للاستخدام التعليمي العادي، وللامتحانات الحساسة يلزم خادم وسيط.
- كلمة مرور الأستاذ وجلسته ما زالتا محليتين، وتغيير كلمة المرور لا ينتقل بين الأجهزة.
- بديل: Supabase (ملف `setup.sql`) إن فضّلته.

---
## إن كنت تستخدم Realtime Database (وليس Firestore)
1. من **Realtime Database ← Rules** الصق محتوى `database.rules.json` واضغط Publish.
2. من تبويب **Data** انسخ رابط القاعدة أعلى الصفحة (يبدو مثل `https://xxxx-default-rtdb.firebaseio.com`) وضعه في `databaseURL` داخل `config.js`.
3. عند وضع `databaseURL` يستخدم النظام Realtime Database تلقائيًا.
