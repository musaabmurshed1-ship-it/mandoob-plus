// منطق السوق: التسجيل، المهام، القبول، الحالات، الدفع النقدي، التتبع.
// منقول ومطوّر من market.ts الأصلي مع الحفاظ على نفس القواعد.
import { transaction } from "./db.mjs";

export const PLATFORM_FEE_HALALAS = 1500; // عمولة ثابتة 15 ر.س
export const MIN_PRICE = 5000;            // 50 ر.س
export const MAX_PRICE = 5_000_000;       // 50,000 ر.س
export const STALE_MS = 30_000;
export const TASK_TYPES = ["توصيل", "وثائق", "استلام", "زيارة موقع"];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new HttpError(status, message); };

export function text(value, field, min = 2, max = 300) {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length < min || s.length > max) fail(`أدخل ${field} بصورة صحيحة.`);
  return s;
}
export function phone(value) {
  const s = text(value, "رقم الجوال", 7, 32);
  if (!/^[+0-9\s\-()]{7,32}$/.test(s)) fail("رقم الجوال غير صالح.");
  return s;
}
function money(v) {
  if (!Number.isInteger(v) || v < MIN_PRICE || v > MAX_PRICE) fail("السعر يجب أن يكون بين 50 و50,000 ر.س.");
  return v;
}
const now = () => new Date().toISOString();

// ---------- تسجيل الملفات الشخصية (يُستدعى من داخل معاملة التسجيل) ----------
export function createCompany(db, userId, input) {
  const r = db.prepare(`INSERT INTO companies (userId,name,contactName,phone,city) VALUES (?,?,?,?,?)`)
    .run(userId, text(input.name, "اسم الشركة", 2, 180), text(input.contactName, "اسم مسؤول التواصل", 2, 180), phone(input.phone), text(input.city || "الرياض", "المدينة", 2, 80));
  return Number(r.lastInsertRowid);
}
export function createAgent(db, userId, input) {
  const r = db.prepare(`INSERT INTO agents (userId,name,phone,city) VALUES (?,?,?,?)`)
    .run(userId, text(input.name, "الاسم", 2, 180), phone(input.phone), text(input.city || "الرياض", "المدينة", 2, 80));
  return Number(r.lastInsertRowid);
}

export function getProfile(db, userId) {
  const company = db.prepare(`SELECT * FROM companies WHERE userId=?`).get(userId);
  if (company) return { role: "company", id: company.id, name: company.name, contactName: company.contactName, phone: company.phone, city: company.city };
  const agent = db.prepare(`SELECT * FROM agents WHERE userId=?`).get(userId);
  if (agent) return { role: "agent", id: agent.id, name: agent.name, phone: agent.phone, city: agent.city, rating: agent.rating };
  return null;
}
function ownedCompany(db, userId) {
  const row = db.prepare(`SELECT * FROM companies WHERE userId=?`).get(userId);
  if (!row) fail("هذا الإجراء متاح لحساب الشركة فقط.", 403);
  return row;
}
function ownedAgent(db, userId) {
  const row = db.prepare(`SELECT * FROM agents WHERE userId=?`).get(userId);
  if (!row) fail("هذا الإجراء متاح لحساب المندوب فقط.", 403);
  return row;
}

// ---------- عرض المهام ----------
function trackingOf(row) {
  if (!row) return null;
  return {
    latitude: row.latitudeE6 / 1e6, longitude: row.longitudeE6 / 1e6,
    accuracyMeters: row.accuracyMeters, updatedAt: row.updatedAt,
    stale: Date.now() - new Date(row.updatedAt).getTime() > STALE_MS,
  };
}

/** يبني عرض المهمة حسب هوية الطالب؛ لا تُكشف بيانات غير مرتبطة به. */
function shape(db, task, viewer) {
  const company = db.prepare(`SELECT * FROM companies WHERE id=?`).get(task.companyId);
  const agent = task.agentId ? db.prepare(`SELECT * FROM agents WHERE id=?`).get(task.agentId) : null;
  const payment = db.prepare(`SELECT * FROM payments WHERE taskId=?`).get(task.id) ?? null;
  const loc = db.prepare(`SELECT * FROM agentLocations WHERE taskId=?`).get(task.id);
  const involved = task.status !== "new";
  const mineAsCompany = viewer.role === "company" && viewer.id === task.companyId;
  const mineAsAgent = viewer.role === "agent" && viewer.id === task.agentId;
  return {
    ...task,
    company: company ? { id: company.id, name: company.name, contactName: company.contactName, city: company.city, phone: involved && mineAsAgent ? company.phone : undefined } : null,
    agent: agent ? { id: agent.id, name: agent.name, rating: agent.rating, city: agent.city, phone: involved && mineAsCompany ? agent.phone : undefined } : null,
    payment,
    // الموقع الحي يظهر لصاحب المهمة (الشركة) وللمندوب المسند فقط
    tracking: (mineAsCompany || mineAsAgent) && (task.status === "accepted" || task.status === "in_progress" || loc) ? trackingOf(loc) : null,
  };
}

export function getSnapshot(db, userId) {
  const active = getProfile(db, userId);
  if (!active) return { active: null, profile: null, tasks: [] };
  let rows;
  if (active.role === "company") {
    rows = db.prepare(`SELECT * FROM tasks WHERE companyId=? ORDER BY createdAt DESC, id DESC`).all(active.id);
  } else {
    rows = db.prepare(`
      SELECT t.* FROM tasks t JOIN companies c ON c.id=t.companyId
      WHERE t.agentId=? OR (t.status='new' AND c.city=?)
      ORDER BY t.createdAt DESC, t.id DESC`).all(active.id, active.city);
  }
  const { phone: _p, ...publicActive } = active;
  return {
    active: { role: active.role, id: active.id, name: active.name },
    profile: { city: active.city, contactName: active.contactName, rating: active.rating, phone: active.phone },
    tasks: rows.map((t) => shape(db, t, publicActive)),
    serverTime: now(),
  };
}

export function getTask(db, userId, taskId) {
  const active = getProfile(db, userId);
  if (!active) fail("أنشئ حسابًا أولًا.", 403);
  const task = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
  if (!task) fail("المهمة غير موجودة.", 404);
  const company = db.prepare(`SELECT city FROM companies WHERE id=?`).get(task.companyId);
  const allowed = active.role === "company" ? task.companyId === active.id
    : task.agentId === active.id || (task.status === "new" && company?.city === active.city);
  if (!allowed) fail("لا تملك صلاحية عرض هذه المهمة.", 403);
  const out = shape(db, task, active);
  if (out.tracking || task.agentId) {
    const trail = db.prepare(`SELECT latitudeE6 a, longitudeE6 b, createdAt FROM agentLocationTrail WHERE taskId=? ORDER BY id DESC LIMIT 60`).all(taskId).reverse();
    out.trail = (active.role === "company" && task.companyId === active.id) || task.agentId === active.id
      ? trail.map((p) => [p.a / 1e6, p.b / 1e6]) : [];
  }
  return out;
}

// ---------- إنشاء المهمة ----------
export function createTask(db, userId, input) {
  const company = ownedCompany(db, userId);
  const priceHalalas = money(input.priceHalalas);
  const title = text(input.title, "عنوان المهمة", 3, 220);
  const type = text(input.type, "نوع المهمة", 2, 100);
  const location = text(input.location, "الموقع", 3, 300);
  const scheduledAt = text(input.scheduledAt, "الوقت", 3, 120);
  const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim().slice(0, 1000) : null;
  return transaction(db, () => {
    const r = db.prepare(`INSERT INTO tasks (companyId,title,type,location,notes,priceHalalas,scheduledAt,status) VALUES (?,?,?,?,?,?,?, 'new')`)
      .run(company.id, title, type, location, notes, priceHalalas, scheduledAt);
    const id = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO payments (taskId,grossHalalas,platformFeeHalalas,agentPayoutHalalas,paymentMethod,status) VALUES (?,?,?,?, 'cash_on_delivery','pending')`)
      .run(id, priceHalalas, PLATFORM_FEE_HALALAS, Math.max(0, priceHalalas - PLATFORM_FEE_HALALAS));
    return { id, companyId: company.id };
  });
}

// ---------- القبول (ذرّي: لا يُسند لمندوبين اثنين) ----------
export function acceptTask(db, userId, taskId) {
  const agent = ownedAgent(db, userId);
  const task = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
  if (!task) fail("المهمة غير موجودة.", 404);
  const company = db.prepare(`SELECT city FROM companies WHERE id=?`).get(task.companyId);
  if (!company || company.city !== agent.city) fail("هذه المهمة خارج مدينتك.", 403);
  const busy = db.prepare(`SELECT id FROM tasks WHERE agentId=? AND status IN ('accepted','in_progress') LIMIT 1`).get(agent.id);
  if (busy) fail("أنهِ مهمتك الحالية قبل قبول مهمة جديدة.", 409);
  const r = db.prepare(`UPDATE tasks SET agentId=?, status='accepted', acceptedAt=?, updatedAt=? WHERE id=? AND status='new'`)
    .run(agent.id, now(), now(), taskId);
  if (Number(r.changes) === 0) fail("تم إسناد هذه المهمة بالفعل.", 409);
  return { ok: true, companyId: task.companyId };
}

// ---------- تحديث الحالة ----------
export function updateTaskStatus(db, userId, taskId, next) {
  if (next !== "in_progress" && next !== "completed") fail("حالة غير صالحة.");
  const agent = ownedAgent(db, userId);
  const task = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
  if (!task) fail("المهمة غير موجودة.", 404);
  if (task.agentId !== agent.id) fail("هذه المهمة ليست مسندة إليك.", 403);
  if ((next === "in_progress" && task.status !== "accepted") || (next === "completed" && task.status !== "in_progress")) fail("انتقال الحالة غير صالح.", 409);
  transaction(db, () => {
    const t = now();
    if (next === "in_progress") db.prepare(`UPDATE tasks SET status='in_progress', startedAt=?, updatedAt=? WHERE id=?`).run(t, t, taskId);
    else {
      db.prepare(`UPDATE tasks SET status='completed', completedAt=?, updatedAt=? WHERE id=?`).run(t, t, taskId);
      // الدفع عند الاستلام: يُسجَّل التحصيل النقدي عند الإتمام
      db.prepare(`UPDATE payments SET status='paid', cashCollectedAt=?, paidAt=?, updatedAt=? WHERE taskId=?`).run(t, t, t, taskId);
    }
  });
  return { ok: true, companyId: task.companyId };
}

// ---------- الموقع الحي ----------
export function updateAgentLocation(db, userId, taskId, input) {
  const agent = ownedAgent(db, userId);
  const task = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
  if (!task) fail("المهمة غير موجودة.", 404);
  if (task.agentId !== agent.id) fail("هذه المهمة ليست مسندة إليك.", 403);
  if (task.status !== "accepted" && task.status !== "in_progress") fail("لا يمكن إرسال الموقع لهذه المهمة الآن.", 409);
  const lat = Number(input.latitude), lng = Number(input.longitude);
  const acc = Math.max(0, Math.round(Number(input.accuracyMeters ?? 0)) || 0);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) fail("إحداثيات الموقع غير صالحة.");
  const latE6 = Math.round(lat * 1e6), lngE6 = Math.round(lng * 1e6), t = now();
  transaction(db, () => {
    db.prepare(`INSERT INTO agentLocations (taskId,agentId,latitudeE6,longitudeE6,accuracyMeters,updatedAt) VALUES (?,?,?,?,?,?)
                ON CONFLICT(taskId) DO UPDATE SET agentId=excluded.agentId, latitudeE6=excluded.latitudeE6, longitudeE6=excluded.longitudeE6, accuracyMeters=excluded.accuracyMeters, updatedAt=excluded.updatedAt`)
      .run(taskId, agent.id, latE6, lngE6, acc, t);
    db.prepare(`INSERT INTO agentLocationTrail (taskId,latitudeE6,longitudeE6,createdAt) VALUES (?,?,?,?)`).run(taskId, latE6, lngE6, t);
    // نحتفظ بآخر 300 نقطة فقط لكل مهمة
    db.prepare(`DELETE FROM agentLocationTrail WHERE taskId=? AND id NOT IN (SELECT id FROM agentLocationTrail WHERE taskId=? ORDER BY id DESC LIMIT 300)`).run(taskId, taskId);
  });
  return { ok: true, updatedAt: t, companyId: task.companyId };
}

export function getTaskTracking(db, userId, taskId) {
  const company = ownedCompany(db, userId);
  const task = db.prepare(`SELECT * FROM tasks WHERE id=? AND companyId=?`).get(taskId, company.id);
  if (!task) fail("المهمة غير موجودة.", 404);
  const loc = db.prepare(`SELECT * FROM agentLocations WHERE taskId=?`).get(taskId);
  const trail = db.prepare(`SELECT latitudeE6 a, longitudeE6 b FROM agentLocationTrail WHERE taskId=? ORDER BY id DESC LIMIT 60`).all(taskId).reverse().map((p) => [p.a / 1e6, p.b / 1e6]);
  return { taskId, status: task.status, tracking: trackingOf(loc), trail };
}
