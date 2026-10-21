# نشر Mandoob+ على Railway أو Render

## Railway (الأسهل)

1. اذهب إلى https://railway.app وأنشئ حسابًا (أو سجّل دخول).
2. New Project → Deploy from GitHub repo (أو Upload).
3. أو من الطرفية بعد تثبيت CLI:
   ```bash
   npm i -g @railway/cli
   railway login
   railway init
   railway up
   ```
4. في Variables أضف:
   - `NODE_VERSION=22`
5. أضف Volume (Persistent Disk):
   - Mount path: `/app/data`
   - هذا يحفظ قاعدة البيانات `mandoob.db`

أمر التشغيل: `npm start`

## Render

1. اذهب إلى https://render.com
2. New → Web Service
3. ارفع المشروع أو اربطه بـ GitHub
4. Runtime: Node
5. Build Command: (فارغ أو `npm install`)
6. Start Command: `npm start`
7. في Advanced → Add Disk:
   - Name: data
   - Mount Path: `/opt/render/project/src/data`
   - Size: 1 GB

## بعد النشر

- افتح الرابط من الجوال.
- في Safari/Chrome: «مشاركة» → «إضافة إلى الشاشة الرئيسية» (Add to Home Screen).
- التطبيق يعمل كـ PWA.
