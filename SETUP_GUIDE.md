# 🚀 دليل إطلاق SyriaExpress — خطوة بخطوة

## المرحلة 1: إعداد قاعدة البيانات (Supabase) — مجاني

### الخطوات:
1. اذهب إلى https://supabase.com وسجّل حساب مجاني
2. اضغط **"New Project"** → اختار اسم المشروع: `syriaexpress`
3. احفظ كلمة المرور في مكان آمن
4. بعد ما يتهيأ المشروع (2 دقيقة) اذهب لـ **SQL Editor**
5. افتح ملف `syriaexpress-schema.sql` وانسخ المحتوى كاملاً والصقه في SQL Editor
6. اضغط **"Run"** — رح تشوف "Success"
7. من القائمة الجانبية اذهب لـ **Settings → Database**
8. انسخ **Connection String** — هيدا هو `DATABASE_URL`

---

## المرحلة 2: إعداد Cloudinary للصور — مجاني

1. اذهب إلى https://cloudinary.com وسجّل حساب مجاني
2. من Dashboard انسخ:
   - `Cloud Name`
   - `API Key`
   - `API Secret`

---

## المرحلة 3: رفع Backend على Railway — مجاني

1. اذهب إلى https://railway.app وسجّل دخول بحساب GitHub
2. اضغط **"New Project" → "Deploy from GitHub repo"**
3. ارفع ملفات الـ Backend على GitHub أولاً:
   ```bash
   git init
   git add .
   git commit -m "SyriaExpress Backend v1.0"
   git push
   ```
4. اختار الـ repo على Railway
5. من **Variables** أضف المتغيرات:
   ```
   DATABASE_URL=postgresql://...    (من Supabase)
   JWT_SECRET=syriaexpress_super_secret_2025
   JWT_EXPIRES_IN=7d
   CLOUDINARY_CLOUD_NAME=...
   CLOUDINARY_API_KEY=...
   CLOUDINARY_API_SECRET=...
   NODE_ENV=production
   FRONTEND_URL=https://your-site.vercel.app
   ```
6. Railway رح يعطيك URL مثل: `https://syriaexpress-backend.railway.app`

---

## المرحلة 4: رفع Frontend على Vercel — مجاني

1. اذهب إلى https://vercel.com وسجّل دخول بحساب GitHub
2. ارفع ملفات الـ Frontend على GitHub
3. اضغط **"New Project"** → اختار الـ repo
4. Vercel رح يعطيك URL مثل: `https://syriaexpress.vercel.app`
5. عدّل `FRONTEND_URL` في Railway بالـ URL الجديد

---

## المرحلة 5: ربط Frontend بـ Backend

في كل صفحة HTML أضف هاد في بداية الـ `<script>`:
```javascript
const API_BASE = 'https://syriaexpress-backend.railway.app/api';

// مثال: جلب المنتجات
const response = await fetch(`${API_BASE}/products?category=food`);
const data = await response.json();
```

---

## API Endpoints الكاملة

### 🔐 Auth
| Method | Endpoint | الوصف |
|--------|----------|-------|
| POST | /api/auth/register | تسجيل مستخدم جديد |
| POST | /api/auth/login | تسجيل الدخول |
| GET  | /api/auth/me | معلومات المستخدم الحالي |

### 📦 Products
| Method | Endpoint | الوصف |
|--------|----------|-------|
| GET  | /api/products | كل المنتجات (مع فلاتر) |
| GET  | /api/products/:id | تفاصيل منتج |
| POST | /api/products | إضافة منتج (بائع) |
| PUT  | /api/products/:id | تعديل منتج (بائع) |
| DELETE | /api/products/:id | حذف منتج |

### 📬 Orders
| Method | Endpoint | الوصف |
|--------|----------|-------|
| POST | /api/orders | إنشاء طلب جديد |
| GET  | /api/orders/my | طلبات المشتري |
| GET  | /api/orders/seller | طلبات البائع الواردة |
| PATCH | /api/orders/:id/status | تحديث حالة الطلب |

### 🏭 Sellers
| Method | Endpoint | الوصف |
|--------|----------|-------|
| GET  | /api/sellers | كل البائعين |
| GET  | /api/sellers/:id | تفاصيل بائع |
| GET  | /api/sellers/me/dashboard | إحصائيات البائع |
| PUT  | /api/sellers/me | تعديل الملف |

### 🛒 Cart
| Method | Endpoint | الوصف |
|--------|----------|-------|
| GET  | /api/cart | محتوى السلة |
| POST | /api/cart | إضافة للسلة |
| DELETE | /api/cart/:product_id | حذف من السلة |
| POST | /api/cart/checkout | إرسال كل الطلبات |

### 🔔 Notifications
| Method | Endpoint | الوصف |
|--------|----------|-------|
| GET  | /api/notifications | كل الإشعارات |
| PATCH | /api/notifications/read-all | تحديد الكل كمقروء |

### ⚙️ Admin (يتطلب admin token)
| Method | Endpoint | الوصف |
|--------|----------|-------|
| GET  | /api/admin/overview | نظرة عامة |
| GET  | /api/admin/verifications | طلبات التوثيق |
| PATCH | /api/admin/verifications/:id | قبول/رفض توثيق |
| GET  | /api/admin/users | إدارة المستخدمين |
| PATCH | /api/admin/users/:id/status | تعليق/تفعيل حساب |
| GET  | /api/admin/analytics | التحليلات |
| GET/PUT | /api/admin/settings | إعدادات المنصة |
