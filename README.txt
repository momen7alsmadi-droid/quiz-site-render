نشر الموقع على Render (بقاعدة بيانات مشتركة بين كل الأجهزة)
===========================================================
المشكلة السابقة: الأسئلة كانت تُحفظ داخل متصفح كل جهاز. الآن تُحفظ على الخادم في MongoDB Atlas (مجاني ودائم).

1) أنشئ قاعدة مجانية: https://www.mongodb.com/cloud/atlas  -> Create Free Cluster (M0)
   - Database Access: أنشئ مستخدمًا وكلمة مرور.
   - Network Access: Add IP Address -> Allow access from anywhere (0.0.0.0/0).
   - Connect -> Drivers: انسخ رابط الاتصال (mongodb+srv://...) وضع كلمة مرورك مكان <password>.
2) ارفع محتويات هذا المجلد إلى GitHub.
3) في Render: New + > Web Service > اختر المستودع (مهم: ليس Static Site).
   - Build Command: npm install
   - Start Command: node server.js
   - Environment: أضف MONGODB_URI = رابط الاتصال من الخطوة 1
   - (اختياري) IMPORT_PASSWORD = كلمة مرور إضافة الأسئلة (الافتراضي 2580)
4) بعد النشر ادخل الموقع وأضف الأسئلة مرة واحدة من جهازك؛ ستظهر لكل الأجهزة.

ملاحظة: الأسئلة القديمة المحفوظة في متصفحك لن تنتقل تلقائيًا، أعد رفع ملف Excel مرة واحدة.
الخطة المجانية تنام بعد 15 دقيقة بلا زيارات (أول فتح يتأخر قليلًا)؛ يمكن استخدام خدمة بينق على /health.
