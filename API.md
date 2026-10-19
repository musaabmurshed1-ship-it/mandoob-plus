# Mandoob+ API

كل الاستجابات JSON. الأخطاء بالشكل `{ "error": "رسالة عربية" }` مع رمز HTTP مناسب
(400 تحقق، 401 غير مسجّل، 403 غير مصرّح، 404 غير موجود، 409 تعارض، 429 كثرة طلبات).

**المصادقة:** كوكي `mp_session` (HttpOnly) يُضبط عند التسجيل/الدخول، أو ترويسة
`Authorization: Bearer <token>` للتطبيقات الأصلية (الرمز يرجع في `token`).

## الحساب
| الطريقة | المسار | الجسم | الوصف |
|---|---|---|---|
| POST | `/api/auth/register` | شركة: `{role:"company",email,password,name,contactName,phone,city}` — مندوب: `{role:"agent",email,password,name,phone,city}` | ينشئ الحساب والملف ويسجّل الدخول (201) |
| POST | `/api/auth/login` | `{email,password}` | دخول |
| POST | `/api/auth/logout` | — | يمسح الجلسة |
| GET | `/api/auth/me` | — | `{profile, email}` أو `{profile:null}` |

## السوق (يتطلب تسجيل دخول)
| الطريقة | المسار | من | الوصف |
|---|---|---|---|
| GET | `/api/market/bootstrap` | الكل | `{active, profile, tasks[]}`: الشركة ترى مهامها، المندوب يرى مهامه + الجديدة في مدينته |
| GET | `/api/market/tasks/:id` | صاحب المهمة/المندوب المسند/مندوب بنفس المدينة (للجديدة) | تفاصيل + مسار الموقع `trail` |
| POST | `/api/market/tasks` | شركة | `{title,type,location,notes?,priceHalalas,scheduledAt}` — السعر 5000–5,000,000 هللة؛ ينشئ دفعة نقدية بعمولة 1500 هللة |
| POST | `/api/market/tasks/:id/accept` | مندوب | قبول ذرّي؛ 409 إن أُسندت أو لديه مهمة جارية؛ 403 خارج مدينته |
| POST | `/api/market/tasks/:id/status` | المندوب المسند | `{nextStatus:"in_progress"\|"completed"}`؛ الإتمام يسجّل التحصيل النقدي |
| POST | `/api/market/tasks/:id/location` | المندوب المسند | `{latitude,longitude,accuracyMeters?}` أثناء accepted/in_progress فقط |
| GET | `/api/market/tasks/:id/tracking` | الشركة المالكة | `{tracking:{latitude,longitude,accuracyMeters,updatedAt,stale}\|null, trail[]}` |
| GET | `/api/market/stream` | الكل | بثّ SSE: `refresh` عند تغيّر المهام، و`location` ({taskId,tracking}) للشركة لحظة وصول موقع جديد |
| GET | `/api/health` | — | فحص الحالة |

الحالات: `new → accepted → in_progress → completed`. الدفع: `cash_on_delivery` فقط (حقل `moyasar` محجوز في المخطط دون تفعيل).
