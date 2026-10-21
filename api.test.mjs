import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../index.mjs";

let app, base;
before(async () => {
  app = createApp({ dbFile: ":memory:", secretFile: ":memory:" });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const reg = (role, email, extra = {}) => call("POST", "/api/auth/register", { body: { role, email, password: "password123", phone: "0555555555", city: "الرياض", ...(role === "company" ? { name: "شركة آفاق", contactName: "سارة" } : { name: "خالد المندوب" }), ...extra } });

let company, agent, agent2, outsider, taskId;

test("تسجيل شركة ومندوبين وحماية التكرار", async () => {
  const c = await reg("company", "c@x.sa"); assert.equal(c.status, 201); company = c.data.token; assert.equal(c.data.profile.role, "company");
  const a = await reg("agent", "a@x.sa"); assert.equal(a.status, 201); agent = a.data.token;
  const a2 = await reg("agent", "a2@x.sa", { name: "ماجد" }); agent2 = a2.data.token;
  const o = await reg("agent", "jeddah@x.sa", { name: "مندوب جدة", city: "جدة" }); outsider = o.data.token;
  assert.equal((await reg("company", "c@x.sa")).status, 409);
  assert.equal((await reg("agent", "bad")).status, 400);
  assert.equal((await call("POST", "/api/auth/register", { body: { role: "agent", email: "z@x.sa", password: "123" } })).status, 400);
});

test("تسجيل الدخول والجلسة", async () => {
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "c@x.sa", password: "wrongpass1" } })).status, 401);
  const ok = await call("POST", "/api/auth/login", { body: { email: "C@x.sa", password: "password123" } });
  assert.equal(ok.status, 200); assert.ok(ok.data.token);
  assert.equal((await call("GET", "/api/market/bootstrap")).status, 401);
  assert.equal((await call("GET", "/api/market/bootstrap", { token: "bad.token" })).status, 401);
});

test("إنشاء مهمة: تحقق ودفع نقدي وعمولة", async () => {
  const bad = await call("POST", "/api/market/tasks", { token: company, body: { title: "x", type: "توصيل", location: "حي", priceHalalas: 100, scheduledAt: "اليوم" } });
  assert.equal(bad.status, 400);
  assert.equal((await call("POST", "/api/market/tasks", { token: agent, body: { title: "مهمة", type: "توصيل", location: "الملقا", priceHalalas: 10000, scheduledAt: "اليوم" } })).status, 403);
  const ok = await call("POST", "/api/market/tasks", { token: company, body: { title: "تسليم عقد", type: "وثائق", location: "حي الملقا، الرياض", priceHalalas: 12000, scheduledAt: "اليوم 16:30", notes: "اتصل عند الوصول" } });
  assert.equal(ok.status, 201); taskId = ok.data.id;
  const snap = await call("GET", "/api/market/bootstrap", { token: company });
  const t = snap.data.tasks.find((x) => x.id === taskId);
  assert.equal(t.status, "new"); assert.equal(t.payment.paymentMethod, "cash_on_delivery");
  assert.equal(t.payment.platformFeeHalalas, 1500); assert.equal(t.payment.agentPayoutHalalas, 10500);
});

test("قائمة المندوب: نفس المدينة فقط، والقبول ذرّي", async () => {
  assert.equal((await call("GET", "/api/market/bootstrap", { token: agent })).data.tasks.length, 1);
  assert.equal((await call("GET", "/api/market/bootstrap", { token: outsider })).data.tasks.length, 0);
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/accept`, { token: outsider })).status, 403);
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/accept`, { token: company })).status, 403);
  const [r1, r2] = await Promise.all([call("POST", `/api/market/tasks/${taskId}/accept`, { token: agent }), call("POST", `/api/market/tasks/${taskId}/accept`, { token: agent2 })]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  // المهمة اختفت من القائمة المتاحة للآخر
  const winner = r1.status === 200 ? agent : agent2, loser = r1.status === 200 ? agent2 : agent;
  assert.equal((await call("GET", "/api/market/bootstrap", { token: loser })).data.tasks.length, 0);
  agent = winner; agent2 = loser;
});

test("الموقع الحي: صلاحيات وتحقق وظهور للشركة فقط", async () => {
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/location`, { token: agent2, body: { latitude: 24.7, longitude: 46.7 } })).status, 403);
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/location`, { token: agent, body: { latitude: 200, longitude: 46.7 } })).status, 400);
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/location`, { token: agent, body: { latitude: "abc", longitude: 46.7 } })).status, 400);
  assert.equal((await call("GET", `/api/market/tasks/${taskId}/tracking`, { token: company })).data.tracking, null);
  const ok = await call("POST", `/api/market/tasks/${taskId}/location`, { token: agent, body: { latitude: 24.7136, longitude: 46.6753, accuracyMeters: 12 } });
  assert.equal(ok.status, 200);
  await call("POST", `/api/market/tasks/${taskId}/location`, { token: agent, body: { latitude: 24.7140, longitude: 46.6760, accuracyMeters: 9 } });
  const tr = await call("GET", `/api/market/tasks/${taskId}/tracking`, { token: company });
  assert.equal(tr.data.tracking.latitude, 24.714); assert.equal(tr.data.tracking.longitude, 46.676); assert.equal(tr.data.tracking.stale, false); assert.equal(tr.data.trail.length, 2);
  assert.equal((await call("GET", `/api/market/tasks/${taskId}/tracking`, { token: agent })).status, 403);
  // شركة أخرى لا ترى المهمة
  const other = (await reg("company", "c2@x.sa", { name: "شركة أخرى" })).data.token;
  assert.equal((await call("GET", `/api/market/tasks/${taskId}/tracking`, { token: other })).status, 404);
  assert.equal((await call("GET", `/api/market/tasks/${taskId}`, { token: other })).status, 403);
});

test("دورة الحياة: لا قفزات، والتحصيل النقدي عند الإتمام", async () => {
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/status`, { token: agent, body: { nextStatus: "completed" } })).status, 409);
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/status`, { token: agent2, body: { nextStatus: "in_progress" } })).status, 403);
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/status`, { token: agent, body: { nextStatus: "new" } })).status, 400);
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/status`, { token: agent, body: { nextStatus: "in_progress" } })).status, 200);
  assert.equal((await call("GET", `/api/market/tasks/${taskId}`, { token: company })).data.status, "in_progress");
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/status`, { token: agent, body: { nextStatus: "completed" } })).status, 200);
  const t = (await call("GET", `/api/market/tasks/${taskId}`, { token: company })).data;
  assert.equal(t.status, "completed"); assert.equal(t.payment.status, "paid"); assert.ok(t.payment.cashCollectedAt);
  assert.equal(t.agent.phone, "0555555555");
  // بعد الإتمام لا يقبل الموقع
  assert.equal((await call("POST", `/api/market/tasks/${taskId}/location`, { token: agent, body: { latitude: 24.7, longitude: 46.7 } })).status, 409);
});

test("البث الحي SSE: الشركة تستلم الموقع لحظيًا", async () => {
  const t2 = (await call("POST", "/api/market/tasks", { token: company, body: { title: "استلام طرد", type: "استلام", location: "العليا", priceHalalas: 8000, scheduledAt: "الآن" } })).data.id;
  const ctrl = new AbortController();
  const res = await fetch(base + "/api/market/stream", { headers: { Authorization: `Bearer ${company}` }, signal: ctrl.signal });
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /event-stream/);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  const waitFor = async (needle) => { const dl = Date.now() + 4000; while (!buf.includes(needle)) { if (Date.now() > dl) throw new Error("timeout waiting " + needle + " got " + buf); const { value } = await reader.read(); buf += dec.decode(value); } };
  await waitFor("event: hello");
  await call("POST", `/api/market/tasks/${t2}/accept`, { token: agent });
  await waitFor("accepted");
  await call("POST", `/api/market/tasks/${t2}/location`, { token: agent, body: { latitude: 24.75, longitude: 46.69, accuracyMeters: 5 } });
  await waitFor("event: location"); await waitFor("24.75");
  ctrl.abort();
});

test("المسارات الثابتة والأمان", async () => {
  const home = await fetch(base + "/"); assert.equal(home.status, 200);
  assert.equal((await fetch(base + "/..%2f..%2fserver%2fauth.mjs")).status === 200 && (await (await fetch(base + "/..%2f..%2fserver%2fauth.mjs")).text()).includes("scryptSync"), false);
  assert.equal((await call("GET", "/api/nope")).status, 404);
});

test("ملفات الـ PWA تُخدَّم بالأنواع والكاش الصحيحين", async () => {
  const get = (p) => fetch(base + p);
  const html = await (await get("/")).text();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /serviceWorker/);

  const mf = await get("/manifest.webmanifest");
  assert.equal(mf.status, 200);
  assert.match(mf.headers.get("content-type"), /application\/manifest\+json/);
  const manifest = await mf.json();
  assert.equal(manifest.name, "Mandoob+");
  assert.equal(manifest.short_name, "مندوب بلس");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  for (const icon of manifest.icons) assert.equal((await get(icon.src)).status, 200, icon.src);

  const sw = await get("/sw.js");
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type"), /javascript/);
  assert.equal(sw.headers.get("cache-control"), "no-cache");
  const swText = await sw.text();
  // كل ملف في قائمة الـ precache يجب أن يكون موجودًا وإلا فشل تثبيت الـ SW كله
  const shell = JSON.parse(swText.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"));
  for (const p of shell) assert.equal((await get(p)).status, 200, p);
  assert.match(swText, /startsWith\("\/api\/"\)/);
});

test("صلابة الخادم: مسار تالف، وعزل حد الطلبات لكل عميل خلف بروكسي", async () => {
  // ترميز تالف يجب أن يرجع 400 لا 500
  const bad = await fetch(base + "/%E0%A4%A");
  assert.equal(bad.status, 400);
  // محاولة الخروج من المجلد العام
  assert.ok([400, 403, 404].includes((await fetch(base + "/..%2f..%2fpackage.json")).status));
  assert.notEqual((await fetch(base + "/..%2fpackage.json")).status, 200);

  // عميل مزعج (IP-A) يستهلك حدّه، وعميل آخر (IP-B) خلف نفس البروكسي لا يتأثر
  const login = (ip) => fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify({ email: "nobody@x.sa", password: "wrong-password" }) });
  let last;
  for (let i = 0; i < 17; i++) last = await login("203.0.113.10");
  assert.equal(last.status, 429);
  assert.equal((await login("203.0.113.77")).status, 401);

  // كوكي Secure عند HTTPS خلف البروكسي
  const r = await fetch(base + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https", "X-Forwarded-For": "198.51.100.5" }, body: JSON.stringify({ role: "agent", email: "sec@x.sa", password: "password123", phone: "0555555555", city: "الرياض", name: "مندوب أمان" }) });
  assert.equal(r.status, 201);
  assert.match(r.headers.get("set-cookie"), /; Secure/);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
});
