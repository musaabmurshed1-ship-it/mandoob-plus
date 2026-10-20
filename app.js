// Mandoob+ — الواجهة الأمامية (RTL عربي). بلا إطار عمل؛ كل النصوص تُدرج عبر textContent (آمنة من XSS).
import { h, icon, sar, fmtAge, fmtDate, api, ApiError } from "./lib.js";
import { LiveMap } from "./map.js";

const CITIES = ["الرياض", "جدة", "مكة المكرمة", "المدينة المنورة", "الدمام", "الخبر", "الطائف", "أبها", "تبوك", "بريدة"];
const TYPES = ["توصيل", "وثائق", "استلام", "زيارة موقع"];
const STATUS = {
  new: { label: "جديدة", icon: "sparkles" },
  accepted: { label: "مقبولة", icon: "check-circle" },
  in_progress: { label: "جارية", icon: "navigation" },
  completed: { label: "مكتملة", icon: "check-double" },
};

const $app = document.getElementById("app");
const $tabs = document.getElementById("tabs");
const $toast = document.getElementById("toast");
const $offline = document.getElementById("offline");

const S = { booted: false, profile: null, email: null, data: null, loading: false, error: null, es: null, detail: null, detailError: null };
const maps = new Map(); // taskId -> LiveMap (تبقى حيّة بين إعادة الرسم)

// ---------------------------------------------------------------- أدوات
let toastTimer;
function toast(msg, err = false) {
  $toast.textContent = msg; $toast.className = "toast" + (err ? " err" : ""); $toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => ($toast.hidden = true), 3200);
}
const isOffline = (e) => !navigator.onLine || (e instanceof TypeError) || (e instanceof ApiError && e.status === 0);
const nav = (path) => { if (location.hash === "#" + path) render(); else location.hash = path; };
const route = () => {
  const p = (location.hash.replace(/^#/, "") || "/").split("?")[0];
  const m = p.match(/^\/task\/(\d+)$/);
  if (m) return { name: "task", id: Number(m[1]) };
  if (p === "/task/new") return { name: "new" };
  return { name: { "/": "home", "/tasks": "tasks", "/account": "account", "/login": "login", "/register": "register" }[p] ?? "home" };
};

// ---------------------------------------------------------------- بيانات
/** لا نسمح لاستجابة قديمة (أُرسل طلبها قبل وصول بثّ الموقع) بمحو موقع أحدث. */
function keepNewerTracking(oldT, newT) {
  if (oldT?.tracking && newT && (!newT.tracking || oldT.tracking.updatedAt > newT.tracking.updatedAt)) newT.tracking = oldT.tracking;
  return newT;
}
async function loadSnapshot({ silent = false } = {}) {
  if (!S.profile) return;
  if (!silent) { S.loading = true; S.error = null; render(); }
  try {
    const next = await api("GET", "/api/market/bootstrap");
    for (const t of next.tasks) keepNewerTracking(S.data?.tasks.find((x) => x.id === t.id), t);
    S.data = next;
    S.error = null;
    for (const t of S.data.tasks) if (t.tracking) maps.get(t.id)?.update(t.tracking, t.trail);
    syncGeo();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return signedOut();
    if (!silent || !S.data) S.error = e;
  } finally { S.loading = false; render(); }
}
async function loadDetail(id, { silent = false } = {}) {
  try {
    const t = await api("GET", `/api/market/tasks/${id}`);
    S.detailError = null;
    if (route().name === "task" && route().id === id) { S.detail = keepNewerTracking(S.detail?.id === id ? S.detail : null, t); if (t.tracking) maps.get(id)?.update(t.tracking, t.trail); }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return signedOut();
    S.detailError = e; if (!silent) S.detail = null;
  }
  render();
}
function signedOut() {
  S.profile = null; S.data = null; S.detail = null; stopStream(); stopGeo();
  for (const m of maps.values()) m.destroy(); maps.clear();
  nav("/login");
}

// ---------------------------------------------------------------- البثّ الحي (SSE) + احتياطي بالاستطلاع
function startStream() {
  stopStream();
  if (!S.profile || !window.EventSource) return;
  const es = new EventSource("/api/market/stream");
  S.es = es;
  es.addEventListener("refresh", async () => {
    await loadSnapshot({ silent: true });
    const r = route(); if (r.name === "task") await loadDetail(r.id, { silent: true });
  });
  es.addEventListener("location", (ev) => {
    const { taskId, tracking } = JSON.parse(ev.data);
    applyTracking(taskId, tracking);
  });
  es.onerror = () => { /* المتصفح يعيد الاتصال تلقائيًا */ };
}
/** يطبّق موقعًا جديدًا: يحرّك الخريطة ويحدّث الأرقام دون إعادة رسم الصفحة. */
function applyTracking(taskId, tracking) {
  const list = [S.data?.tasks.find((x) => x.id === taskId), S.detail?.id === taskId ? S.detail : null].filter(Boolean);
  const first = list.some((t) => !t.tracking);
  for (const t of list) t.tracking = tracking;
  maps.get(taskId)?.update(tracking, null);
  if (first) return render(); // أول موقع: تتحول البطاقة من "بانتظار" إلى الخريطة
  document.querySelectorAll(`[data-live-meta="${taskId}"]`).forEach((el) => el.setAttribute("data-ts", tracking.updatedAt));
  document.querySelectorAll(`[data-lat="${taskId}"]`).forEach((el) => (el.textContent = tracking.latitude.toFixed(5)));
  document.querySelectorAll(`[data-lng="${taskId}"]`).forEach((el) => (el.textContent = tracking.longitude.toFixed(5)));
  document.querySelectorAll(`[data-acc="${taskId}"]`).forEach((el) => (el.textContent = `±${tracking.accuracyMeters} م`));
  tick();
}
function stopStream() { S.es?.close(); S.es = null; }
setInterval(() => {
  if (!S.profile || document.hidden) return;
  if (!S.es || S.es.readyState !== 1) {
    loadSnapshot({ silent: true });
    const r = route(); if (r.name === "task") loadDetail(r.id, { silent: true });
  }
}, 10_000);

// مؤقّت الثانية: يحدّث "منذ كذا" وحالة التقادم دون إعادة رسم
function tick() {
  const now = Date.now();
  document.querySelectorAll("[data-ts]").forEach((el) => {
    const ts = el.getAttribute("data-ts");
    el.textContent = ts ? fmtAge(ts, now) : "بانتظار أول تحديث";
  });
  document.querySelectorAll("[data-stale-for]").forEach((el) => {
    const t = findTask(Number(el.getAttribute("data-stale-for")));
    const ts = t?.tracking?.updatedAt;
    const stale = ts ? now - new Date(ts).getTime() > 30_000 : false;
    if (el.classList.contains("stale")) el.hidden = !stale;
    if (el.classList.contains("live-dot")) el.classList.toggle("live", !!ts && !stale);
  });
}
setInterval(tick, 1000);
const findTask = (id) => (S.detail?.id === id ? S.detail : S.data?.tasks.find((t) => t.id === id));

// ---------------------------------------------------------------- مشاركة موقع المندوب
const G = { watch: null, taskId: null, last: 0, pos: null, state: "idle", timer: null, pending: null };
function agentActiveTask() {
  if (S.profile?.role !== "agent" || !S.data) return null;
  return S.data.tasks.find((t) => t.agentId === S.profile.id && (t.status === "accepted" || t.status === "in_progress")) ?? null;
}
function setGeo(state) { G.state = state; document.querySelectorAll("[data-geo]").forEach((el) => el.replaceWith(geoPill())); }
function syncGeo() {
  const t = agentActiveTask();
  if (!t) return stopGeo();
  if (G.taskId === t.id && G.watch != null) return;
  stopGeo(); startGeo(t.id);
}
async function pushPos(taskId) {
  if (!G.pos) return;
  G.last = Date.now();
  try { await api("POST", `/api/market/tasks/${taskId}/location`, G.pos); if (G.state !== "active") setGeo("active"); }
  catch (e) { if (e instanceof ApiError && e.status === 409) stopGeo(); }
}
function startGeo(taskId) {
  if (!navigator.geolocation) return setGeo("unsupported");
  G.taskId = taskId; setGeo("asking");
  G.watch = navigator.geolocation.watchPosition(
    (p) => {
      G.pos = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyMeters: Math.round(p.coords.accuracy || 0) };
      // إرسال فوري إن مرّت 4 ثوانٍ، وإلا نؤجّل آخر موقع (trailing) كي لا يضيع التحديث الأخير
      const wait = 4000 - (Date.now() - G.last);
      if (wait <= 0) pushPos(taskId);
      else if (!G.pending) G.pending = setTimeout(() => { G.pending = null; pushPos(taskId); }, wait);
    },
    (err) => { setGeo(err.code === 1 ? "denied" : "error"); },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
  );
  // نبض احتياطي: يعيد إرسال آخر موقع كي لا تبدو البيانات قديمة عند ثبات المندوب
  G.timer = setInterval(() => { if (G.pos && Date.now() - G.last >= 12_000) pushPos(taskId); }, 4000);
}
function stopGeo() {
  if (G.watch != null) navigator.geolocation.clearWatch(G.watch);
  clearInterval(G.timer); clearTimeout(G.pending); Object.assign(G, { watch: null, taskId: null, pos: null, timer: null, pending: null, state: "idle" });
}
function geoPill() {
  const map = {
    asking: ["warn", "wifi", "نطلب صلاحية الموقع… اسمح بها ليرى العميل موقعك."],
    active: ["ok", "navigation", "موقعك يُشارك الآن مع الشركة لحظة بلحظة."],
    denied: ["bad", "alert", "صلاحية الموقع مرفوضة. فعّلها من إعدادات المتصفح ثم أعد تحميل الصفحة."],
    unsupported: ["bad", "alert", "جهازك لا يدعم مشاركة الموقع."],
    error: ["warn", "alert", "تعذّر تحديد موقعك حاليًا، سنعيد المحاولة تلقائيًا."],
    idle: ["warn", "wifi", "ستبدأ مشاركة الموقع بعد قبول المهمة."],
  };
  const [cls, ic, msg] = map[G.state] ?? map.idle;
  return h("div", { class: `geo-pill ${cls}`, "data-geo": "1" }, icon(ic), h("span", {}, msg));
}

// ---------------------------------------------------------------- مكوّنات
const Brand = () => h("div", { class: "brand" }, h("div", { class: "logo" }, h("img", { src: "/icon.svg", alt: "" })),
  h("div", {}, h("div", { class: "brand-name", dir: "ltr", style: "text-align:start" }, "Mandoob", h("b", {}, "+")), h("div", { class: "brand-tag" }, "منصة المهام داخل المدينة")));
const StatusChip = (s) => h("span", { class: `chip ${s}` }, icon(STATUS[s].icon), STATUS[s].label);
const Section = (title, action) => h("div", { class: "section-head" }, h("h2", {}, title), action ?? null);
const Btn = (label, onclick, { ic, cls = "", disabled = false } = {}) => h("button", { class: `btn ${cls}`, onclick, disabled, type: "button" }, ic ? icon(ic) : null, label);
const State = ({ ic = "sparkles", tone = "", title, body, action }) => h("div", { class: "state" }, h("div", { class: `ic ${tone}` }, icon(ic)), h("h3", {}, title), body ? h("p", {}, body) : null, action ?? null);
const Loading = (msg = "جارٍ التحميل…") => h("div", {}, h("div", { class: "loading" }, h("div", { class: "spinner" }), msg), h("div", { class: "skeleton", style: "margin-top:24px" }), h("div", { class: "skeleton", style: "margin-top:12px" }));
function RetryState(onRetry, e) {
  const off = isOffline(e);
  return State({ ic: off ? "wifi-off" : "alert", tone: off ? "warn" : "err", title: off ? "لا يوجد اتصال" : "تعذر تحميل البيانات",
    body: off ? "تحقق من اتصالك بالإنترنت ثم حاول مجددًا." : (e?.message || "حدث خطأ مؤقت أثناء مزامنة المهام."), action: Btn("إعادة المحاولة", onRetry, { ic: "refresh", cls: "ghost" }) });
}
function TaskCard(t, { showCompany = false } = {}) {
  return h("button", { class: "task-card", type: "button", onclick: () => nav(`/task/${t.id}`) },
    h("div", { class: "task-top" }, StatusChip(t.status), h("span", { class: "task-price" }, sar(t.priceHalalas))),
    h("div", { class: "task-title" }, t.title),
    h("div", { class: "task-meta" }, icon("pin"), h("span", {}, t.location)),
    h("div", { class: "task-bottom" }, h("span", { class: "pill" }, t.type), h("span", { class: "time" }, t.scheduledAt)),
    showCompany && t.company ? h("span", { class: "by" }, `بواسطة ${t.company.name}`) : null);
}
function AcceptableCard(t) {
  const btn = h("button", { class: "accept-bar", type: "button" }, icon("hand"), "قبول المهمة");
  btn.onclick = async () => {
    btn.disabled = true;
    try { await api("POST", `/api/market/tasks/${t.id}/accept`); toast("تم قبول المهمة. ستبدأ مشاركة موقعك تلقائيًا."); await loadSnapshot({ silent: true }); nav(`/task/${t.id}`); }
    catch (e) { toast(e.message, true); btn.disabled = false; loadSnapshot({ silent: true }); }
  };
  return h("div", { class: "task-wrap" }, TaskCard(t, { showCompany: true }), btn);
}

/** لوحة التتبع المباشر: خريطة حيّة + آخر تحديث + تنبيه عند الانقطاع. */
function TrackingCard(task) {
  const tr = task.tracking;
  let lm = maps.get(task.id);
  if (!lm) { lm = new LiveMap(); maps.set(task.id, lm); }
  const mapSlot = h("div", { class: "map-box" });
  mapSlot.append(lm.el);
  queueMicrotask(() => { lm.mount(); if (tr) lm.update(tr, task.trail); });
  const waiting = h("div", { class: "map-empty", "data-empty-for": task.id }, icon("pin"), h("b", {}, "بانتظار مشاركة الموقع"), h("p", {}, "سيظهر موقع المندوب تلقائيًا بعد منحه صلاحية الموقع وبدء إرسال الإحداثيات."));
  return h("div", { class: "card tracking", "data-tracking": task.id },
    h("div", { class: "tracking-head" },
      h("span", { class: "live-dot" + (tr && !tr.stale ? " live" : ""), "data-stale-for": task.id }),
      h("div", { class: "grow" }, h("b", {}, "تتبع المندوب المباشر"),
        h("small", {}, `${task.agent?.name ?? ""} • `, h("span", { "data-ts": tr?.updatedAt ?? "", "data-live-meta": task.id }, tr ? fmtAge(tr.updatedAt) : "بانتظار أول تحديث"))),
      icon("navigation")),
    tr ? mapSlot : waiting,
    tr ? h("div", { class: "track-stats" },
      h("div", {}, h("small", {}, "خط العرض"), h("b", { "data-lat": task.id, dir: "ltr" }, tr.latitude.toFixed(5))),
      h("div", {}, h("small", {}, "خط الطول"), h("b", { "data-lng": task.id, dir: "ltr" }, tr.longitude.toFixed(5))),
      h("div", {}, h("small", {}, "الدقة التقريبية"), h("b", { "data-acc": task.id }, `±${tr.accuracyMeters} م`))) : null,
    h("div", { class: "stale", "data-stale-for": task.id, hidden: !(tr && tr.stale) }, icon("clock"), h("span", {}, "آخر موقع قديم نسبيًا؛ ننتظر تحديثًا جديدًا من المندوب.")));
}

// ---------------------------------------------------------------- الشاشات
function Welcome() {
  return h("div", { class: "welcome" }, Brand(),
    h("div", { class: "orb" }, icon("send")),
    h("h1", {}, "أرسل مهمتك بثقة"),
    h("p", {}, "Mandoob+ يربط شركات المدينة بمندوبين مستقلين، من الطلب إلى التسليم مع تتبع مباشر على الخريطة."),
    h("div", { class: "feature-list" },
      Feature("pin", "تتبع لحظي", "شاهد موقع المندوب وهو ينفّذ مهمتك"),
      Feature("cash", "الدفع عند الاستلام", "عمولة ثابتة 15 ر.س لكل مهمة"),
      Feature("shield", "حسابات محمية", "كل شركة ومندوب بهوية مستقلة")),
    Btn("إنشاء حساب", () => nav("/register"), { ic: "user-plus", cls: "teal" }),
    Btn("لدي حساب — تسجيل الدخول", () => nav("/login"), { ic: "log-in", cls: "ghost" }));
}
const Feature = (ic, t, s) => h("div", { class: "feature" }, h("div", { class: "ic" }, icon(ic)), h("div", {}, h("b", {}, t), h("small", {}, s)));

function Login() {
  const err = h("div", { class: "error-box", hidden: true });
  const email = h("input", { type: "email", autocomplete: "email", placeholder: "name@company.sa", dir: "ltr", required: true });
  const pw = h("input", { type: "password", autocomplete: "current-password", placeholder: "••••••••", dir: "ltr", required: true });
  const btn = h("button", { class: "btn", type: "submit" }, icon("log-in"), "دخول");
  const form = h("form", { class: "form", novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault(); err.hidden = true; btn.disabled = true;
    try { const r = await api("POST", "/api/auth/login", { email: email.value, password: pw.value }); await afterAuth(r.profile); }
    catch (e) { err.textContent = isOffline(e) ? "لا يوجد اتصال بالإنترنت." : e.message; err.hidden = false; btn.disabled = false; }
  } },
    Field("البريد الإلكتروني", "mail", email), Field("كلمة المرور", "lock", pw), err, btn);
  return h("div", { class: "form", style: "gap:20px" }, Brand(),
    h("div", {}, h("div", { class: "overline", style: "color:var(--teal)" }, "أهلًا بعودتك"), h("h1", { style: "font-size:27px;font-weight:900;color:var(--navy)" }, "تسجيل الدخول")),
    form, h("div", { class: "switch-auth" }, "ليس لديك حساب؟ ", h("button", { onclick: () => nav("/register") }, "أنشئ حسابًا")));
}

function Register() {
  let role = "company";
  const f = { email: input("email", "name@company.sa", "email"), pw: input("password", "8 أحرف على الأقل", "new-password"), name: input("text", ""), contact: input("text", "اسم مسؤول التواصل"), phone: input("tel", "05xxxxxxxx", "tel"), };
  f.email.dir = f.pw.dir = f.phone.dir = "ltr";
  const city = h("select", {}, ...CITIES.map((c) => h("option", { value: c }, c)));
  const err = h("div", { class: "error-box", hidden: true });
  const btn = h("button", { class: "btn teal", type: "submit" }, icon("user-plus"), "إنشاء الحساب");
  const nameField = h("div", { class: "field" }), contactField = h("div", { class: "field" });
  const roleBtns = {};
  const paint = () => {
    for (const [k, b] of Object.entries(roleBtns)) b.setAttribute("aria-pressed", String(k === role));
    f.name.placeholder = role === "company" ? "مثال: شركة آفاق" : "اسمك الكامل";
    nameField.replaceChildren(h("label", {}, role === "company" ? "اسم الشركة" : "الاسم الكامل"), h("div", { class: "control" }, icon(role === "company" ? "building" : "user"), f.name));
    contactField.hidden = role !== "company";
    contactField.replaceChildren(h("label", {}, "مسؤول التواصل"), h("div", { class: "control" }, icon("user"), f.contact));
  };
  const Role = (k, title, sub, ic) => (roleBtns[k] = h("button", { class: "role", type: "button", onclick: () => { role = k; paint(); } }, h("div", { class: "ic" }, icon(ic)), h("b", {}, title), h("span", {}, sub)));
  const form = h("form", { class: "form", novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault(); err.hidden = true; btn.disabled = true;
    try {
      const body = { role, email: f.email.value, password: f.pw.value, name: f.name.value, phone: f.phone.value, city: city.value };
      if (role === "company") body.contactName = f.contact.value;
      const r = await api("POST", "/api/auth/register", body); toast("تم إنشاء حسابك بنجاح"); await afterAuth(r.profile);
    } catch (e) { err.textContent = isOffline(e) ? "لا يوجد اتصال بالإنترنت." : e.message; err.hidden = false; btn.disabled = false; }
  } },
    h("div", { class: "roles" }, Role("company", "شركة", "أنشئ وراقب مهام المدينة", "building"), Role("agent", "مندوب", "اقبل المهام ونفّذها", "bike")),
    nameField, contactField, Field("رقم الجوال", "phone", f.phone), Field("المدينة", "pin", city),
    Field("البريد الإلكتروني", "mail", f.email), Field("كلمة المرور", "lock", f.pw), err, btn);
  paint();
  return h("div", { class: "form", style: "gap:20px" }, h("div", { class: "top-row" }, Brand(), h("button", { class: "icon-btn", "aria-label": "رجوع", onclick: () => nav("/login") }, icon("x"))),
    h("div", {}, h("div", { class: "overline", style: "color:var(--teal)" }, "حساب جديد"), h("h1", { style: "font-size:27px;font-weight:900;color:var(--navy)" }, "كيف ستستخدم Mandoob+؟"), h("p", { class: "hint", style: "margin-top:4px" }, "سنرتب شاشتك وعملياتك وفقًا لنوع حسابك.")),
    form, h("div", { class: "switch-auth" }, "لديك حساب؟ ", h("button", { onclick: () => nav("/login") }, "سجّل الدخول")));
}
const input = (type, placeholder = "", autocomplete) => h("input", { type, placeholder, autocomplete: autocomplete ?? "off" });
const Field = (label, ic, control, hint) => h("div", { class: "field" }, h("label", {}, label), h("div", { class: "control" }, icon(ic), control), hint ? h("span", { class: "hint" }, hint) : null);

// ----- الرئيسية
function Home() {
  if (!S.profile) return Welcome();
  if (!S.data && !S.error) return Loading("نجهّز لوحة التحكم…");
  if (S.error && !S.data) return h("div", { class: "form", style: "gap:18px" }, Brand(), RetryState(() => loadSnapshot(), S.error));
  return S.profile.role === "company" ? CompanyHome() : AgentHome();
}
function CompanyHome() {
  const tasks = S.data?.tasks ?? [];
  const current = tasks.filter((t) => t.status !== "completed");
  const tracked = tasks.filter((t) => t.agentId && (t.status === "accepted" || t.status === "in_progress"));
  const done = tasks.filter((t) => t.status === "completed");
  const paid = tasks.filter((t) => t.payment?.status === "paid").reduce((s, t) => s + t.priceHalalas, 0);
  const metric = (ic, c, v, l) => h("div", { class: "metric" }, h("div", { class: "ic", style: `background:${c}1f;color:${c}` }, icon(ic)), h("div", { class: "v" }, v), h("div", { class: "l" }, l));
  let selected = S.trackedSel && tracked.some((t) => t.id === S.trackedSel) ? S.trackedSel : tracked[0]?.id;
  const trackBox = h("div", { class: "form", style: "gap:10px" });
  const paintTrack = () => {
    const t = tracked.find((x) => x.id === selected);
    trackBox.replaceChildren(...[
      tracked.length > 1 ? h("div", { class: "tabs-mini" }, ...tracked.map((x) => h("button", { type: "button", "aria-pressed": String(x.id === selected), onclick: () => { selected = x.id; S.trackedSel = x.id; paintTrack(); } }, x.title))) : null,
      t ? TrackingCard(t) : null, t ? Btn("فتح تفاصيل المهمة", () => nav(`/task/${t.id}`), { ic: "arrow", cls: "ghost" }) : null].filter(Boolean));
  };
  paintTrack();
  return h("div", { class: "form", style: "gap:18px" },
    h("div", { class: "top-row" }, Brand(), h("span", { class: "badge" }, icon("building"), "شركة")),
    h("div", { class: "hero" }, h("div", { class: "overline" }, "لوحة التحكم"), h("h1", {}, `مرحبًا، ${S.profile.name}`), h("p", {}, "أدِر المهام، راقب التنفيذ لحظة بلحظة، واستلم المندوب قيمة المهمة نقدًا عند التسليم."), Btn("إنشاء مهمة جديدة", () => nav("/task/new"), { ic: "plus-circle", cls: "lime" })),
    h("div", { class: "metrics" }, metric("zap", "#00BFA6", String(current.length), "قيد التنفيذ"), metric("check-double", "#218C63", String(done.length), "مكتملة"), metric("cash", "#6561D8", sar(paid), "مبالغ محصلة")),
    tracked.length ? Section("موقع المندوب الآن") : null, tracked.length ? trackBox : null,
    Section("مهامك الأخيرة", tasks.length ? h("button", { class: "link", onclick: () => nav("/tasks") }, "عرض الكل") : null),
    tasks.length ? h("div", { class: "form", style: "gap:12px" }, ...tasks.slice(0, 3).map((t) => TaskCard(t))) : State({ ic: "inbox", title: "لا توجد مهام بعد", body: "أنشئ أول مهمة وسيتاح قبولها للمندوبين في مدينتك فورًا.", action: Btn("إنشاء مهمة", () => nav("/task/new"), { ic: "plus-circle" }) }));
}
function AgentHome() {
  const tasks = S.data?.tasks ?? [];
  const mine = tasks.find((t) => t.agentId === S.profile.id && t.status !== "completed");
  const open = tasks.filter((t) => t.status === "new");
  const done = tasks.filter((t) => t.agentId === S.profile.id && t.status === "completed");
  const earned = done.reduce((s, t) => s + (t.payment?.agentPayoutHalalas ?? 0), 0);
  return h("div", { class: "form", style: "gap:18px" },
    h("div", { class: "top-row" }, Brand(), h("span", { class: "badge" }, icon("bike"), "مندوب")),
    h("div", { class: "hero" }, h("div", { class: "overline" }, `منطقة عملك: ${S.data.profile.city}`), h("h1", {}, `أهلًا ${S.profile.name}`), h("p", {}, "مهامك المتاحة تُحدَّث تلقائيًا لحظة وصولها. اختر مهمة وابدأ التحرك."),
      h("div", { class: "badge", style: "align-self:flex-start;background:#18315B;color:var(--lime)" }, icon("check-circle"), "متاح لاستلام المهام")),
    h("div", { class: "metrics" }, h("div", { class: "metric" }, h("div", { class: "v" }, String(open.length)), h("div", { class: "l" }, "مهام متاحة")), h("div", { class: "metric" }, h("div", { class: "v" }, String(done.length)), h("div", { class: "l" }, "أنجزتها")), h("div", { class: "metric" }, h("div", { class: "v" }, sar(earned)), h("div", { class: "l" }, "صافي أرباحك"))),
    Section(mine ? "المهمة الحالية" : "ابدأ مهمتك التالية"),
    mine ? TaskCard(mine) : (open.length ? h("div", { class: "form", style: "gap:12px" }, ...open.slice(0, 2).map(AcceptableCard)) : State({ ic: "compass", title: "لا توجد مهام الآن", body: "سنحدّث هذه الشاشة تلقائيًا عند وصول طلب جديد في مدينتك." })),
    !mine && open.length > 2 ? Btn(`عرض كل المهام المتاحة (${open.length})`, () => nav("/tasks"), { cls: "ghost", ic: "list" }) : null);
}

// ----- قائمة المهام
function Tasks() {
  if (!S.profile) return Welcome();
  if (!S.data && !S.error) return Loading("نحدّث قائمة المهام…");
  if (S.error && !S.data) return h("div", { class: "form", style: "gap:18px" }, Brand(), RetryState(() => loadSnapshot(), S.error));
  const tasks = S.data?.tasks ?? [];
  if (S.profile.role === "company") {
    const filter = S.filter ?? "all";
    const shown = tasks.filter((t) => filter === "all" || (filter === "active" ? t.status !== "completed" : t.status === "completed"));
    const seg = (k, l) => h("button", { type: "button", "aria-pressed": String(filter === k), onclick: () => { S.filter = k; render(); } }, l);
    return h("div", { class: "form", style: "gap:16px" },
      h("div", { class: "top-row" }, Brand(), h("button", { class: "icon-btn navy", "aria-label": "مهمة جديدة", onclick: () => nav("/task/new") }, icon("plus"))),
      Section("كل مهام الشركة"), h("div", { class: "seg" }, seg("all", "الكل"), seg("active", "الحالية"), seg("done", "السابقة")),
      shown.length ? h("div", { class: "form", style: "gap:12px" }, ...shown.map((t) => TaskCard(t))) : State({ ic: "inbox", title: "لا توجد مهام", body: "أضف مهمة جديدة وسيتاح قبولها للمندوبين فورًا.", action: Btn("إنشاء مهمة", () => nav("/task/new"), { ic: "plus-circle" }) }));
  }
  const open = tasks.filter((t) => t.status === "new");
  const mine = tasks.filter((t) => t.agentId === S.profile.id && t.status !== "completed");
  const done = tasks.filter((t) => t.agentId === S.profile.id && t.status === "completed");
  return h("div", { class: "form", style: "gap:16px" },
    h("div", { class: "top-row" }, Brand(), h("span", { class: "badge" }, `${open.length} متاحة`)),
    mine.length ? Section("قيد التنفيذ") : null, ...mine.map((t) => TaskCard(t)),
    Section(`طلبات جديدة في ${S.data.profile.city}`),
    open.length ? h("div", { class: "form", style: "gap:12px" }, ...open.map(AcceptableCard)) : State({ ic: "sparkles", title: "لا توجد مهام جديدة", body: "سنحدّث هذه الشاشة تلقائيًا عند وصول طلب جديد." }),
    done.length ? Section("أنجزتها سابقًا") : null, ...done.map((t) => TaskCard(t)));
}

// ----- مهمة جديدة
function NewTask() {
  if (S.profile?.role !== "company") return State({ ic: "building", title: "هذه الشاشة لحسابات الشركات", body: "سجّل الدخول بحساب شركة لنشر مهمة.", action: Btn("رجوع", () => nav("/"), { ic: "arrow" }) });
  let type = TYPES[0];
  const title = input("text", "مثال: تسليم عقد للعميل");
  const location = input("text", "الحي، الشارع، المعلم القريب");
  const price = input("number", "مثال: 120"); price.min = 50; price.max = 50000; price.step = 1; price.inputMode = "numeric"; price.dir = "ltr";
  const when = h("select", {}, h("option", { value: "في أقرب وقت" }, "في أقرب وقت"), h("option", { value: "خلال ساعة" }, "خلال ساعة"), h("option", { value: "اليوم مساءً" }, "اليوم مساءً"), h("option", { value: "custom" }, "تحديد وقت…"));
  const dt = h("input", { type: "datetime-local" }); const dtField = h("div", { class: "field", hidden: true }, h("div", { class: "control" }, icon("clock"), dt));
  when.onchange = () => (dtField.hidden = when.value !== "custom");
  const notes = h("textarea", { placeholder: "تعليمات إضافية للمندوب (اختياري)", maxlength: 1000 });
  const err = h("div", { class: "error-box", hidden: true });
  const net = h("div", { class: "hint" }, "عمولة Mandoob+ الثابتة: 15 ر.س، والباقي صافي للمندوب.");
  price.oninput = () => { const v = Number(price.value); net.textContent = v >= 50 ? `عمولة Mandoob+ 15 ر.س • صافي المندوب ${sar(Math.round(v * 100) - 1500)}` : "عمولة Mandoob+ الثابتة: 15 ر.س، والباقي صافي للمندوب."; };
  const seg = h("div", { class: "seg" }); const paintSeg = () => seg.replaceChildren(...TYPES.map((t) => h("button", { type: "button", "aria-pressed": String(t === type), onclick: () => { type = t; paintSeg(); } }, t))); paintSeg();
  const btn = h("button", { class: "btn teal", type: "submit" }, icon("send"), "نشر المهمة");
  const form = h("form", { class: "card form", novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault(); err.hidden = true;
    const p = Number(price.value);
    if (!title.value.trim() || !location.value.trim() || !(p >= 50)) { err.textContent = "أدخل العنوان والموقع وسعرًا لا يقل عن 50 ر.س."; err.hidden = false; return; }
    let scheduledAt = when.value;
    if (scheduledAt === "custom") { if (!dt.value) { err.textContent = "حدّد التاريخ والوقت."; err.hidden = false; return; } scheduledAt = fmtDate(dt.value); }
    btn.disabled = true;
    try {
      const r = await api("POST", "/api/market/tasks", { title: title.value.trim(), type, location: location.value.trim(), notes: notes.value.trim() || undefined, priceHalalas: Math.round(p * 100), scheduledAt });
      toast("تم نشر المهمة وإشعار المندوبين"); await loadSnapshot({ silent: true }); nav(`/task/${r.id}`);
    } catch (e) { err.textContent = isOffline(e) ? "لا يوجد اتصال بالإنترنت." : e.message; err.hidden = false; btn.disabled = false; }
  } },
    Field("عنوان المهمة", "edit", title), h("div", { class: "field" }, h("label", {}, "نوع المهمة"), seg),
    Field("الموقع داخل المدينة", "pin", location, `المدينة: ${S.profile.city}`),
    h("div", { class: "row-2" }, Field("السعر (ر.س)", "cash", price), Field("الوقت", "clock", when)), dtField, net,
    h("div", { class: "field" }, h("label", {}, "ملاحظات"), h("div", { class: "control" }, notes)), err, btn);
  return h("div", { class: "form", style: "gap:18px" },
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "مهمة جديدة"), h("p", {}, "تفاصيل واضحة = قبول أسرع")), h("button", { class: "icon-btn", "aria-label": "إغلاق", onclick: () => history.length > 1 ? history.back() : nav("/") }, icon("x"))), form);
}

// ----- تفاصيل المهمة
function TaskDetail(id) {
  const t = S.detail?.id === id ? S.detail : null;
  const back = h("button", { class: "icon-btn", "aria-label": "رجوع", onclick: () => nav("/tasks") }, icon("arrow-right"));
  if (!S.profile) return Welcome();
  if (!t) {
    if (S.detailError) return h("div", { class: "form", style: "gap:18px" }, h("div", { class: "top-row" }, Brand(), back), S.detailError instanceof ApiError && [403, 404].includes(S.detailError.status)
      ? State({ ic: "lock", title: "المهمة غير متاحة", body: S.detailError.message, action: Btn("رجوع", () => nav("/tasks"), { ic: "arrow", cls: "ghost" }) }) : RetryState(() => { S.detailError = null; render(); loadDetail(id); }, S.detailError));
    return Loading("نحمّل تفاصيل المهمة…");
  }
  const isCompany = S.profile.role === "company", isAgent = S.profile.role === "agent";
  const mineAgent = isAgent && t.agentId === S.profile.id;
  const pay = t.payment;
  const steps = [["new", "تم إنشاء المهمة", t.createdAt], ["accepted", "قبول المندوب", t.acceptedAt], ["in_progress", "بدء التنفيذ", t.startedAt], ["completed", "اكتمال المهمة", t.completedAt]];
  const order = steps.map((s) => s[0]); const cur = order.indexOf(t.status);
  const timeline = h("div", { class: "timeline" }, ...steps.map(([k, label, ts], i) => h("div", { class: `step ${i < cur || t.status === "completed" ? "done" : i === cur ? "current" : ""}` }, h("div", { class: "dot" }, i <= cur ? icon("check") : null), h("div", {}, h("b", {}, label), ts ? h("small", {}, fmtDate(ts)) : null))));

  const counterpart = isCompany ? t.agent : t.company;
  const contact = counterpart && t.status !== "new" ? h("div", { class: "card contact" }, h("div", { class: `avatar ${isCompany ? "" : "teal"}` }, icon(isCompany ? "bike" : "building")), h("div", { class: "grow" }, h("b", {}, counterpart.name), h("small", {}, isCompany ? `مندوب • تقييم ${(counterpart.rating / 10).toFixed(1)}` : `${t.company.contactName ?? ""} • شركة`)),
    counterpart.phone ? h("a", { class: "call", href: `tel:${counterpart.phone}`, "aria-label": "اتصال" }, icon("phone")) : null) : null;

  const actions = [];
  if (isAgent && t.status === "new") actions.push(actionBtn("قبول المهمة", "hand", "lime", async () => { await api("POST", `/api/market/tasks/${id}/accept`); toast("تم قبول المهمة"); }));
  if (mineAgent && t.status === "accepted") actions.push(actionBtn("بدء التنفيذ", "navigation", "teal", async () => { await api("POST", `/api/market/tasks/${id}/status`, { nextStatus: "in_progress" }); toast("بدأت المهمة"); }));
  if (mineAgent && t.status === "in_progress") actions.push(actionBtn("إتمام المهمة وتحصيل المبلغ نقدًا", "check-double", "", async () => {
    if (!confirm(`هل حصّلت ${sar(t.priceHalalas)} نقدًا وسلّمت المهمة؟`)) return false;
    await api("POST", `/api/market/tasks/${id}/status`, { nextStatus: "completed" }); toast("اكتملت المهمة. شكرًا لك!");
  }));
  function actionBtn(label, ic, cls, fn) {
    const b = h("button", { class: `btn ${cls}`, type: "button" }, icon(ic), label);
    b.onclick = async () => { b.disabled = true; try { const r = await fn(); if (r !== false) { await loadSnapshot({ silent: true }); await loadDetail(id, { silent: true }); } } catch (e) { toast(e.message, true); loadDetail(id, { silent: true }); } b.disabled = false; };
    return b;
  }

  const showTracking = isCompany && t.agent && (t.status === "accepted" || t.status === "in_progress" || (t.status === "completed" && t.tracking));
  return h("div", { class: "form", style: "gap:16px" },
    h("div", { class: "top-row" }, back, StatusChip(t.status)),
    h("div", {}, h("h1", { class: "detail-title" }, t.title), h("div", { class: "task-meta", style: "margin-top:6px" }, icon("pin"), h("span", {}, t.location))),
    h("div", { class: "card kv" }, kv("نوع المهمة", t.type), kv("الوقت المطلوب", t.scheduledAt), t.company ? kv("الشركة", t.company.name) : null, t.notes ? h("div", {}, h("div", { class: "hint", style: "margin-bottom:4px" }, "ملاحظات"), h("div", { class: "pre" }, t.notes)) : null),
    ...actions,
    mineAgent && (t.status === "accepted" || t.status === "in_progress") ? geoPill() : null,
    showTracking ? TrackingCard(t) : null,
    mineAgent && t.tracking && (t.status === "accepted" || t.status === "in_progress") ? h("div", { class: "hint" }, "آخر موقع أُرسل: ", h("span", { "data-ts": t.tracking.updatedAt }, fmtAge(t.tracking.updatedAt))) : null,
    contact,
    h("div", { class: "card" }, h("h3", { style: "margin-bottom:14px;font-size:15px" }, "مسار المهمة"), timeline),
    pay ? h("div", { class: "card kv" }, h("h3", { style: "font-size:15px" }, "الدفع عند الاستلام"),
      kv("قيمة المهمة", sar(pay.grossHalalas)), kv("عمولة Mandoob+", sar(pay.platformFeeHalalas)), h("div", { class: "divider" }),
      h("div", { class: "kv-row total" }, h("span", {}, "صافي المندوب"), h("span", {}, sar(pay.agentPayoutHalalas))),
      h("div", { class: `cash ${pay.status === "paid" ? "paid" : "pending"}` }, icon(pay.status === "paid" ? "check-circle" : "clock"), pay.status === "paid" ? `تم التحصيل نقدًا ${pay.cashCollectedAt ? "• " + fmtDate(pay.cashCollectedAt) : ""}` : "بانتظار التحصيل النقدي عند إتمام المهمة")) : null);
}
const kv = (k, v) => h("div", { class: "kv-row" }, h("span", {}, k), h("span", {}, v));

// ----- الحساب
function Account() {
  if (!S.profile) return Welcome();
  const p = S.profile;
  const row = (ic, t, s) => h("div", { class: "setting" }, h("div", { class: "ic" }, icon(ic)), h("div", {}, h("b", {}, t), h("small", {}, s)));
  return h("div", { class: "form", style: "gap:18px" }, Brand(),
    h("div", { class: "profile" }, h("div", { class: `avatar ${p.role === "company" ? "teal" : ""}` }, icon(p.role === "company" ? "building" : "bike")), h("h2", {}, p.name),
      h("span", { class: "role-tag" }, p.role === "company" ? "حساب شركة" : "مندوب مستقل"), h("small", {}, `${p.city}${S.email ? " • " + S.email : ""}`)),
    h("div", { class: "settings" },
      row("phone", "رقم الجوال", p.phone ?? "—"),
      row("shield", "ملكية محمية", "لا يمكن تنفيذ المهام أو تحديث الموقع إلا من حسابك."),
      row("navigation", "تتبع مباشر", p.role === "agent" ? "تُشارك موقعك أثناء المهمة المسندة فقط." : "ترى موقع المندوب أثناء المهام المقبولة والجارية فقط."),
      row("cash", "الدفع عند الاستلام", "عمولة ثابتة 15 ر.س. لا توجد بوابة دفع إلكتروني حاليًا.")),
    Btn("تسجيل الخروج", async () => { try { await api("POST", "/api/auth/logout"); } catch { /* ignore */ } signedOut(); }, { ic: "log-out", cls: "ghost" }));
}

// ---------------------------------------------------------------- التبويبات والرسم
function paintTabs(r) {
  const show = !!S.profile && ["home", "tasks", "account"].includes(r.name) || (!!S.profile && ["task"].includes(r.name));
  $tabs.hidden = !show; $app.classList.toggle("no-tabs", !show);
  if (!show) return;
  const items = [["/", "home", "home", "الرئيسية"], ["/tasks", "tasks", "list", S.profile.role === "company" ? "المهام" : "المهام"], ["/account", "account", "user", "حسابي"]];
  const active = r.name === "task" ? "tasks" : r.name;
  $tabs.replaceChildren(h("div", { class: "tabs-inner" }, ...items.map(([path, key, ic, label]) => h("a", { class: "tab" + (active === key ? " active" : ""), href: "#" + path, "aria-current": active === key ? "page" : null }, icon(ic), label))));
}
let lastKey = "";
function render() {
  const r = route();
  if (!S.booted) { $app.replaceChildren(Loading()); $tabs.hidden = true; return; }
  // حراسة المسارات
  if (!S.profile && !["login", "register", "home"].includes(r.name)) return nav("/login");
  if (S.profile && ["login", "register"].includes(r.name)) return nav("/");
  let view;
  switch (r.name) {
    case "login": view = Login(); break;
    case "register": view = Register(); break;
    case "tasks": view = Tasks(); break;
    case "new": view = NewTask(); break;
    case "task": view = TaskDetail(r.id); break;
    case "account": view = Account(); break;
    default: view = Home();
  }
  // نحافظ على حقول النماذج أثناء التحديثات الخلفية
  const key = r.name + (r.id ?? "");
  const formScreens = ["login", "register", "new"];
  if (formScreens.includes(r.name) && lastKey === key && $app.querySelector("form")) { return; }
  lastKey = key;
  const y = window.scrollY;
  $app.replaceChildren(view);
  if (r.name === "task" && S.detail?.id === r.id) { /* لا تقفز للأعلى عند التحديث */ window.scrollTo(0, y); }
  paintTabs(r); tick();
}

async function afterAuth(profile) {
  S.profile = profile; S.data = null; S.error = null; S.booted = true;
  try { const me = await api("GET", "/api/auth/me"); S.email = me.email; } catch { /* غير حرج */ }
  startStream(); nav("/"); await loadSnapshot();
}

window.addEventListener("hashchange", () => {
  const r = route(); lastKey = "";
  if (r.name === "task") { S.detail = null; S.detailError = null; render(); loadDetail(r.id); } else { render(); if (S.profile && ["home", "tasks"].includes(r.name)) loadSnapshot({ silent: true }); }
  window.scrollTo(0, 0);
});
const setOnline = () => { $offline.hidden = navigator.onLine; };
window.addEventListener("online", () => { setOnline(); toast("عاد الاتصال"); loadSnapshot({ silent: true }); startStream(); });
window.addEventListener("offline", setOnline);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.profile) loadSnapshot({ silent: true }); });

(async function boot() {
  setOnline(); render();
  try {
    const me = await api("GET", "/api/auth/me");
    S.profile = me.profile; S.email = me.email ?? null;
  } catch (e) { S.error = e; }
  S.booted = true;
  if (S.error && !S.profile) { $app.replaceChildren(h("div", { class: "form", style: "gap:18px" }, Brand(), RetryState(() => location.reload(), S.error))); return; }
  if (S.profile) { startStream(); const r = route(); if (r.name === "task") loadDetail(r.id); await loadSnapshot(); } else render();
})();

// للاختبارات
window.__mandoob = { S, G };
