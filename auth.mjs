// مصادقة بلا اعتماديات: scrypt لكلمات المرور + رمز جلسة موقّع HMAC (كوكي HttpOnly أو Bearer).
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError, text, createCompany, createAgent } from "./market.mjs";
import { transaction } from "./db.mjs";

export const COOKIE = "mp_session";
const TTL_MS = 30 * 24 * 3600 * 1000;

export function loadSecret(file) {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) return process.env.SESSION_SECRET;
  if (file === ":memory:") return randomBytes(32).toString("hex");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const s = randomBytes(32).toString("hex");
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function hashPassword(pw) {
  const salt = randomBytes(16);
  return `s1$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const [v, saltHex, hashHex] = String(stored).split("$");
  if (v !== "s1" || !saltHex || !hashHex) return false;
  const a = scryptSync(pw, Buffer.from(saltHex, "hex"), 64), b = Buffer.from(hashHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const b64 = (b) => Buffer.from(b).toString("base64url");
export function signToken(secret, userId) {
  const body = b64(JSON.stringify({ uid: userId, exp: Date.now() + TTL_MS }));
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
export function verifyToken(secret, token) {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p.uid : null;
  } catch { return null; }
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
/** يرجع userId من كوكي الجلسة أو ترويسة Bearer (للتطبيقات الأصلية)، وإلا null. */
export function userIdFromRequest(secret, req) {
  const h = req.headers.authorization;
  const token = (h && h.startsWith("Bearer ") ? h.slice(7) : null) || parseCookies(req.headers.cookie)[COOKIE];
  return verifyToken(secret, token);
}
export function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function credentials(body) {
  const email = text(body.email, "البريد الإلكتروني", 5, 254).toLowerCase();
  if (!emailRe.test(email)) throw new HttpError(400, "البريد الإلكتروني غير صالح.");
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8 || password.length > 128) throw new HttpError(400, "كلمة المرور يجب ألا تقل عن 8 أحرف.");
  return { email, password };
}

/** تسجيل شركة أو مندوب: ينشئ المستخدم والملف الشخصي في معاملة واحدة. */
export function register(db, body) {
  const { email, password } = credentials(body);
  if (body.role !== "company" && body.role !== "agent") throw new HttpError(400, "اختر نوع الحساب: شركة أو مندوب.");
  if (db.prepare(`SELECT id FROM users WHERE email=?`).get(email)) throw new HttpError(409, "هذا البريد مسجّل بالفعل.");
  return transaction(db, () => {
    const r = db.prepare(`INSERT INTO users (email,passwordHash,role,lastSignedIn) VALUES (?,?,?,?)`)
      .run(email, hashPassword(password), body.role, new Date().toISOString());
    const userId = Number(r.lastInsertRowid);
    if (body.role === "company") createCompany(db, userId, body); else createAgent(db, userId, body);
    return userId;
  });
}

export function login(db, body) {
  const { email, password } = credentials(body);
  const user = db.prepare(`SELECT * FROM users WHERE email=?`).get(email);
  // نفس الرسالة وزمن مشابه تقريبًا سواء كان البريد موجودًا أم لا
  const ok = user ? verifyPassword(password, user.passwordHash) : (verifyPassword(password, "s1$00$00"), false);
  if (!ok) throw new HttpError(401, "البريد الإلكتروني أو كلمة المرور غير صحيحة.");
  db.prepare(`UPDATE users SET lastSignedIn=? WHERE id=?`).run(new Date().toISOString(), user.id);
  return user.id;
}
