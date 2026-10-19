// اختبار شامل من طرف إلى طرف بمتصفح حقيقي (Playwright):
// شركة + مندوب في سياقين منفصلين، تسجيل → مهمة → قبول → تتبع حي → إتمام.
// التشغيل:  node --no-warnings test/e2e.mjs   (يتطلب playwright و chromium)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { createApp } from "../server/index.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }

const shots = new URL("./screenshots/", import.meta.url).pathname; mkdirSync(shots, { recursive: true });
const withLeafletStub = process.argv.includes("--leaflet-stub");

// نسخة مبسّطة من Leaflet لاختبار مسار الخريطة عند عدم توفر الإنترنت في بيئة الاختبار
const LEAFLET_STUB = `window.L=(()=>{const mk=(o)=>o;
function Layer(){this.ll=[0,0];} Layer.prototype.addTo=function(m){m._layers.push(this);return this;};
Layer.prototype.setLatLng=function(ll){this.ll=ll;window.__stub.moves.push(ll);return this;};
Layer.prototype.setRadius=function(r){this.r=r;return this;}; Layer.prototype.setLatLngs=function(l){this.pts=l;window.__stub.trail=l.length;return this;};
window.__stub={moves:[],trail:0,pans:0};
return{map(el){const m={_layers:[],setView(c){m.c=c;el.setAttribute('data-stub-map','1');el.textContent='STUB MAP';return m},on(){return m},panTo(c){window.__stub.pans++;m.c=c;return m},invalidateSize(){},remove(){}};return m},
tileLayer(){return new Layer()},polyline(p){const l=new Layer();l.pts=p;return l},circle(ll){const l=new Layer();l.ll=ll;return l},marker(ll){const l=new Layer();l.ll=ll;window.__stub.moves.push(ll);return l},divIcon(o){return o}}})();`;

const app = createApp({ dbFile: ":memory:", secretFile: ":memory:" });
await new Promise((r) => app.server.listen(0, r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
const watch = (page, name) => { page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`)); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${name} console: ${m.text()}`); }); };

async function ctx(name, opts = {}) {
  const c = await browser.newContext({ locale: "ar-SA", viewport: { width: 400, height: 860 }, ...opts });
  const p = await c.newPage(); watch(p, name);
  await p.route(/cdnjs\.cloudflare\.com\/.*leaflet\.js/, (r) => withLeafletStub ? r.fulfill({ contentType: "text/javascript", body: LEAFLET_STUB }) : r.abort());
  await p.route(/cdnjs\.cloudflare\.com\/.*leaflet\.css/, (r) => r.fulfill({ contentType: "text/css", body: "" }));
  await p.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  return { c, p };
}
const company = await ctx("company");
const agent = await ctx("agent", { permissions: ["geolocation"], geolocation: { latitude: 24.7136, longitude: 46.6753, accuracy: 15 } });
const cp = company.p, ap = agent.p;
const step = (m) => console.log("•", m);

try {
  // ---- 1) تسجيل شركة
  await cp.goto(base);
  await cp.getByText("إنشاء حساب").first().click();
  await cp.locator('input[placeholder="مثال: شركة آفاق"]').fill("شركة آفاق");
  await cp.locator('input[placeholder="اسم مسؤول التواصل"]').fill("سارة");
  await cp.locator('input[type=tel]').fill("0555123456");
  await cp.locator('input[type=email]').fill("co@example.sa");
  await cp.locator('input[type=password]').fill("password123");
  await cp.getByRole("button", { name: "إنشاء الحساب" }).click();
  await cp.getByText("مرحبًا، شركة آفاق").waitFor();
  step("تسجيل الشركة ولوحة التحكم ✔");
  await cp.screenshot({ path: shots + "01-company-dashboard.png" });

  // ---- 2) تسجيل مندوب
  await ap.goto(base);
  await ap.getByText("إنشاء حساب").first().click();
  await ap.locator("button.role", { hasText: "مندوب" }).click();
  await ap.locator('input[placeholder="اسمك الكامل"]').fill("خالد المندوب");
  await ap.locator('input[type=tel]').fill("0566000111");
  await ap.locator('input[type=email]').fill("ag@example.sa");
  await ap.locator('input[type=password]').fill("password123");
  await ap.getByRole("button", { name: "إنشاء الحساب" }).click();
  await ap.getByText("أهلًا خالد المندوب").waitFor();
  step("تسجيل المندوب ✔");

  // ---- 3) الشركة تنشئ مهمة
  await cp.getByRole("button", { name: "إنشاء مهمة جديدة" }).click();
  await cp.locator('input[placeholder="مثال: تسليم عقد للعميل"]').fill("تسليم عقد للعميل");
  await cp.locator('input[placeholder="الحي، الشارع، المعلم القريب"]').fill("حي الملقا، طريق أنس بن مالك");
  await cp.locator('input[type=number]').fill("120");
  await cp.getByText("صافي المندوب 105").waitFor().catch(() => {}); // معاينة العمولة (أرقام عربية)
  await cp.screenshot({ path: shots + "02-new-task.png" });
  await cp.getByRole("button", { name: "نشر المهمة" }).click();
  await cp.getByText("تسليم عقد للعميل").first().waitFor();
  await cp.getByText("جديدة").first().waitFor();
  step("إنشاء المهمة ✔");

  // ---- 4) المندوب يرى المهمة لحظيًا (بث SSE) ويقبلها
  await ap.getByText("تسليم عقد للعميل").first().waitFor({ timeout: 6000 });
  step("ظهور المهمة للمندوب لحظيًا ✔");
  await ap.screenshot({ path: shots + "03-agent-home.png" });
  await ap.getByRole("button", { name: "قبول المهمة" }).first().click();
  await ap.getByText("مقبولة").first().waitFor();
  await ap.getByText("موقعك يُشارك الآن").waitFor({ timeout: 8000 });
  step("قبول المهمة وبدء مشاركة الموقع ✔");

  // الشركة ترى القبول والتتبع تلقائيًا (بدون إعادة تحميل)
  // الشركة على صفحة تفاصيل المهمة (انتقلت إليها بعد الإنشاء): تظهر لوحة التتبع هناك فورًا
  await cp.getByText("تتبع المندوب المباشر").waitFor({ timeout: 8000 });
  await cp.locator("[data-lat]").first().waitFor({ timeout: 8000 });
  assert.equal(await cp.locator("[data-lat]").first().textContent(), "24.71360");
  assert.equal(await cp.locator("[data-lng]").first().textContent(), "46.67530");
  step("لوحة الشركة تعرض موقع المندوب (24.71360, 46.67530) ✔");

  // ---- 5) تحرّك المندوب → تتحدث لوحة الشركة لحظيًا بلا reload
  await cp.evaluate(() => (window.__marker = "same-page"));
  await agent.c.setGeolocation({ latitude: 24.7201, longitude: 46.6844, accuracy: 8 });
  await cp.waitForFunction(() => document.querySelector("[data-lat]")?.textContent === "24.72010", null, { timeout: 12000 });
  assert.equal(await cp.locator("[data-lng]").first().textContent(), "46.68440");
  assert.equal(await cp.evaluate(() => window.__marker), "same-page", "يجب ألا تُعاد الصفحة");
  step("تحديث الموقع لحظة بلحظة دون إعادة تحميل ✔");
  if (withLeafletStub) {
    const st = await cp.evaluate(() => window.__stub);
    assert.ok(st.moves.some((m) => m[0] === 24.7201 && m[1] === 46.6844), "الدبوس يتحرك إلى الموقع الجديد");
    assert.ok(await cp.locator('[data-stub-map]').count(), "تم إنشاء الخريطة");
    step("مسار Leaflet (دبوس + مسار) ✔");
  } else {
    assert.ok(await cp.locator(".map-fallback").count(), "الخريطة البديلة تظهر عند عدم توفر Leaflet");
    step("الخريطة البديلة عند تعذر Leaflet ✔");
  }
  await cp.screenshot({ path: shots + `04-company-live-tracking${withLeafletStub ? "-stub" : ""}.png`, fullPage: true });

  // ---- 6) انقطاع الإرسال → تنبيه "قديم"
  await ap.context().setOffline(true);
  await ap.evaluate(() => window.__mandoob?.S && 0);
  // نوقف الإرسال بتحويل الشبكة؛ الشركة تتحقق من تقادم الموقع بعد 30 ثانية (نختصر بتعديل الساعة في صفحتها)
  await cp.evaluate(() => { const real = Date.now; Date.now = () => real() + 45_000; });
  await cp.getByText("آخر موقع قديم نسبيًا").waitFor({ state: "visible", timeout: 5000 });
  step("تنبيه انقطاع الموقع ✔");
  await cp.evaluate(() => location.reload());
  await ap.context().setOffline(false);

  // لوحة التحكم الرئيسية تعرض أيضًا قسم "موقع المندوب الآن"
  await cp.locator("a.tab", { hasText: "الرئيسية" }).click();
  await cp.getByText("موقع المندوب الآن").waitFor({ timeout: 8000 });
  await cp.screenshot({ path: shots + "04b-company-home-tracking.png", fullPage: true });

  // ---- 7) المندوب يبدأ ثم يكمل المهمة
  await ap.locator("a.tab", { hasText: "المهام" }).click();
  await ap.locator("button.task-card", { hasText: "تسليم عقد للعميل" }).first().click();
  await ap.getByRole("button", { name: "بدء التنفيذ" }).click();
  await ap.getByText("جارية").first().waitFor();
  await cp.getByText("جارية").first().waitFor({ timeout: 8000 });
  step("تحديث الحالة إلى جارية ومزامنتها للشركة ✔");
  await ap.screenshot({ path: shots + "05-agent-task-detail.png", fullPage: true });

  ap.once("dialog", (d) => d.accept());
  await ap.getByRole("button", { name: /إتمام المهمة/ }).click();
  await ap.getByText("مكتملة").first().waitFor();
  await cp.getByText("مكتملة").first().waitFor({ timeout: 8000 });
  step("إتمام المهمة ومزامنتها ✔");
  await cp.locator("button.task-card").first().click();
  await cp.getByText(/تم التحصيل نقدًا/).waitFor();
  await cp.screenshot({ path: shots + "06-company-completed.png", fullPage: true });
  step("تسجيل التحصيل النقدي ✔");

  // ---- 8) خروج وجلسة محمية
  await cp.locator("a.tab", { hasText: "حسابي" }).click();
  await cp.getByRole("button", { name: "تسجيل الخروج" }).click();
  await cp.getByText("تسجيل الدخول").first().waitFor();
  await cp.goto(base + "/#/tasks");
  await cp.getByText("تسجيل الدخول").first().waitFor();
  step("تسجيل الخروج وحماية المسارات ✔");

  // ---- 9) حالة عدم الاتصال في الواجهة
  await cp.locator('input[type=email]').fill("co@example.sa");
  await cp.locator('input[type=password]').fill("password123");
  await cp.getByRole("button", { name: "دخول" }).click();
  await cp.getByText("مرحبًا، شركة آفاق").waitFor();
  await company.c.setOffline(true);
  await cp.evaluate(() => window.dispatchEvent(new Event("offline")));
  await cp.locator("#offline").waitFor({ state: "visible" });
  step("شريط عدم الاتصال ✔");
  await company.c.setOffline(false);
  await cp.evaluate(() => window.dispatchEvent(new Event("online")));

  assert.deepEqual(errors, [], "أخطاء في المتصفح:\n" + errors.join("\n"));
  console.log("\n✅ نجح الاختبار الشامل" + (withLeafletStub ? " (Leaflet stub)" : ""));
} catch (e) {
  console.error("\n❌ فشل:", e.message);
  await cp.screenshot({ path: shots + "FAIL-company.png", fullPage: true }).catch(() => {});
  await ap.screenshot({ path: shots + "FAIL-agent.png", fullPage: true }).catch(() => {});
  console.error("أخطاء المتصفح:", errors);
  process.exitCode = 1;
} finally {
  await browser.close(); await app.close();
}
