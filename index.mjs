// خادم Mandoob+ — Node http فقط (بدون اعتماديات). يخدم الواجهة و REST API وبثًّا حيًّا (SSE).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.mjs";
import * as M from "./market.mjs";
import { HttpError } from "./market.mjs";
import * as A from "./auth.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

class Reply { constructor(body, status = 200, headers = {}) { this.body = body; this.status = status; this.headers = headers; } }

export function createApp({ dbFile = join(ROOT, "data", "mandoob.db"), secretFile = join(ROOT, "data", ".session-secret"), publicDir = join(ROOT, "public") } = {}) {
  const db = openDb(dbFile);
  const secret = A.loadSecret(secretFile);

  // ---------- بثّ حي (SSE): userId -> مجموعة اتصالات ----------
  const streams = new Map();
  const send = (userIds, event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const uid of new Set(userIds)) for (const res of streams.get(uid) ?? []) res.write(payload);
  };
  const userOfCompany = (id) => db.prepare(`SELECT userId u FROM companies WHERE id=?`).get(id)?.u;
  const userOfAgent = (id) => db.prepare(`SELECT userId u FROM agents WHERE id=?`).get(id)?.u;
  const agentUsersInCity = (company) => db.prepare(`SELECT a.userId u FROM agents a JOIN companies c ON c.city=a.city WHERE c.id=?`).all(company).map((r) => r.u);

  // ---------- تحديد معدّل الطلبات (حماية بسيطة) ----------
  const hits = new Map();
  function limited(key, max, windowMs) {
    const t = Date.now(); const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    arr.push(t); hits.set(key, arr);
    return arr.length > max;
  }
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 120_000)) hits.delete(k); }, 60_000).unref();

  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 100_000) throw new HttpError(413, "الطلب كبير جدًا."); chunks.push(c); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "صيغة JSON غير صالحة."); }
  }

  const baseHeaders = {
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(self)",
  };
  function json(res, status, body, extra = {}) {
    res.writeHead(status, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  }

  // ---------- مسارات API ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler, auth });
  const tid = (p) => { const n = Number(p.id); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "معرّف غير صالح."); return n; };

  route("GET", "/api/health", async () => ({ ok: true, timestamp: Date.now() }), { auth: false });

  route("POST", "/api/auth/register", async (ctx) => {
    if (limited(`reg:${ctx.ip}`, 10, 60_000)) throw new HttpError(429, "محاولات كثيرة، حاول لاحقًا.");
    const userId = A.register(db, ctx.body);
    const token = A.signToken(secret, userId);
    return new Reply({ token, profile: M.getProfile(db, userId) }, 201, { "Set-Cookie": A.sessionCookie(token, ctx.secure) });
  }, { auth: false });

  route("POST", "/api/auth/login", async (ctx) => {
    if (limited(`login:${ctx.ip}`, 15, 60_000)) throw new HttpError(429, "محاولات كثيرة، حاول لاحقًا.");
    const userId = A.login(db, ctx.body);
    const token = A.signToken(secret, userId);
    return new Reply({ token, profile: M.getProfile(db, userId) }, 200, { "Set-Cookie": A.sessionCookie(token, ctx.secure) });
  }, { auth: false });

  route("POST", "/api/auth/logout", async () => new Reply({ ok: true }, 200, { "Set-Cookie": A.clearCookie }), { auth: false });
  route("GET", "/api/auth/me", async (ctx) => {
    const uid = A.userIdFromRequest(secret, ctx.req);
    if (!uid) return { profile: null };
    const user = db.prepare(`SELECT email FROM users WHERE id=?`).get(uid);
    return { profile: M.getProfile(db, uid), email: user?.email ?? null };
  }, { auth: false });

  route("GET", "/api/market/bootstrap", async (ctx) => M.getSnapshot(db, ctx.userId));
  route("GET", "/api/market/tasks/:id", async (ctx) => M.getTask(db, ctx.userId, tid(ctx.params)));
  route("GET", "/api/market/tasks/:id/tracking", async (ctx) => M.getTaskTracking(db, ctx.userId, tid(ctx.params)));

  route("POST", "/api/market/tasks", async (ctx) => {
    if (limited(`task:${ctx.userId}`, 30, 60_000)) throw new HttpError(429, "طلبات كثيرة، حاول لاحقًا.");
    const r = M.createTask(db, ctx.userId, ctx.body);
    send(agentUsersInCity(r.companyId), "refresh", { reason: "task_created", taskId: r.id });
    return new Reply({ id: r.id }, 201);
  });
  route("POST", "/api/market/tasks/:id/accept", async (ctx) => {
    const r = M.acceptTask(db, ctx.userId, tid(ctx.params));
    send([userOfCompany(r.companyId), ctx.userId], "refresh", { reason: "accepted", taskId: tid(ctx.params) });
    // بقية مندوبي المدينة: اختفت المهمة من القائمة المتاحة
    send(agentUsersInCity(r.companyId), "refresh", { reason: "taken", taskId: tid(ctx.params) });
    return { ok: true };
  });
  route("POST", "/api/market/tasks/:id/status", async (ctx) => {
    const r = M.updateTaskStatus(db, ctx.userId, tid(ctx.params), ctx.body?.nextStatus);
    send([userOfCompany(r.companyId), ctx.userId], "refresh", { reason: "status", taskId: tid(ctx.params), status: ctx.body.nextStatus });
    return { ok: true };
  });
  route("POST", "/api/market/tasks/:id/location", async (ctx) => {
    if (limited(`loc:${ctx.userId}`, 40, 10_000)) throw new HttpError(429, "تحديثات الموقع متكررة جدًا.");
    const id = tid(ctx.params);
    const r = M.updateAgentLocation(db, ctx.userId, id, ctx.body ?? {});
    const tracking = db.prepare(`SELECT * FROM agentLocations WHERE taskId=?`).get(id);
    send([userOfCompany(r.companyId)], "location", {
      taskId: id,
      tracking: { latitude: tracking.latitudeE6 / 1e6, longitude: tracking.longitudeE6 / 1e6, accuracyMeters: tracking.accuracyMeters, updatedAt: tracking.updatedAt, stale: false },
    });
    return { ok: true, updatedAt: r.updatedAt };
  });

  // بثّ حي للمستخدم الحالي
  function openStream(ctx) {
    const { res, userId } = ctx;
    res.writeHead(200, { ...baseHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 3000\nevent: hello\ndata: {"ok":true}\n\n`);
    if (!streams.has(userId)) streams.set(userId, new Set());
    streams.get(userId).add(res);
    const beat = setInterval(() => res.write(`: ping\n\n`), 20_000);
    ctx.req.on("close", () => { clearInterval(beat); streams.get(userId)?.delete(res); if (!streams.get(userId)?.size) streams.delete(userId); });
    return { handled: true };
  }
  route("GET", "/api/market/stream", async (ctx) => openStream(ctx));

  // ---------- الملفات الثابتة ----------
  async function serveStatic(req, res, pathname) {
    let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    let file = join(publicDir, rel);
    if (!file.startsWith(publicDir)) return json(res, 403, { error: "ممنوع." });
    try { if (!(await stat(file)).isFile()) throw 0; }
    catch { if (extname(rel)) return json(res, 404, { error: "غير موجود." }); file = join(publicDir, "index.html"); }
    const data = await readFile(file);
    res.writeHead(200, { ...baseHeaders, "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=300" });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "طريقة غير مسموحة." });
        return await serveStatic(req, res, url.pathname);
      }
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (!m) continue;
        const ctx = {
          req, res, url, params: m.groups ?? {}, ip: req.socket.remoteAddress ?? "?",
          secure: req.headers["x-forwarded-proto"] === "https", userId: null, body: null,
        };
        if (r.auth) {
          ctx.userId = A.userIdFromRequest(secret, req);
          if (!ctx.userId || !db.prepare(`SELECT 1 FROM users WHERE id=?`).get(ctx.userId)) return json(res, 401, { error: "يلزم تسجيل الدخول." });
        }
        if (req.method === "POST" || req.method === "PUT") ctx.body = await readJson(req);
        const out = await r.handler(ctx);
        if (out?.handled) return;
        if (out instanceof Reply) return json(res, out.status, out.body, out.headers);
        return json(res, 200, out);
      }
      json(res, 404, { error: "المسار غير موجود." });
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      if (e?.code === "ERR_SQLITE_ERROR" && /UNIQUE/.test(e.message ?? "")) return json(res, 409, { error: "السجل موجود بالفعل." });
      console.error("[api] خطأ غير متوقع:", e);
      if (!res.headersSent) json(res, 500, { error: "حدث خطأ في الخادم." });
    }
  });

  return { server, db, close: () => new Promise((r) => { for (const set of streams.values()) for (const s of set) s.end(); server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }) };
}

// تشغيل مباشر: node server/index.mjs
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp({ dbFile: process.env.DB_FILE || undefined });
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`Mandoob+ يعمل على http://localhost:${port}`));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.close().then(() => process.exit(0)));
}
