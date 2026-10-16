النشر على Render
================
الطريقة الموصى بها (Static Site - مجانية ولا تنام):
1) ارفع محتويات هذا المجلد إلى مستودع GitHub (الملفات في جذر المستودع).
2) في Render: New + > Static Site > اختر المستودع.
   - Build Command: اتركه فارغًا
   - Publish Directory: .
3) اضغط Create. الموقع يعمل ولا يحتاج بينق لأنه ملفات ثابتة.
(أو New + > Blueprint ليقرأ الإعدادات من render.yaml.)

الطريقة البديلة (Web Service):
   - Runtime: Node
   - Build Command: اتركه فارغًا
   - Start Command: node server.js
   - Health Check Path: /health
   - هذه الطريقة تنام في الخطة المجانية بعد 15 دقيقة بلا زيارات، فاستخدم خدمة بينق على الرابط /health

ملاحظة: كل البيانات تُحفظ داخل متصفح كل مستخدم (IndexedDB)، ولا تتشارك بين الأجهزة.
كلمة مرور إضافة الأسئلة: 2580 (من أعلى ملف localdb.js).
