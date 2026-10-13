import "dotenv/config";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

// ล็อกอินเจ้าของร้านด้วยรหัสผ่านเดียว (ตั้ง ADMIN_PASSWORD ใน .env) token แบบเซ็นด้วย HMAC หมดอายุใน 12 ชม.
// ถ้าไม่ตั้ง ADMIN_PASSWORD = ปิดระบบล็อกอิน (เหมือนเดิม) แต่จะเตือนในคอนโซล

const PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");
const TTL_MS = 12 * 3600 * 1000;

export const authRequired = () => PASSWORD !== "";
if (!authRequired()) console.warn("⚠ ยังไม่ได้ตั้ง ADMIN_PASSWORD — หน้าเจ้าของร้านเปิดให้ใครก็ใช้ได้");

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const sign = (body: string) => crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
const same = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const checkPassword = (input: unknown) => authRequired() && typeof input === "string" && same(input, PASSWORD);

export const issueToken = () => {
    const body = b64(JSON.stringify({ exp: Date.now() + TTL_MS }));
    return { token: `${body}.${sign(body)}`, expires_in: TTL_MS / 1000 };
};

const validToken = (token: string) => {
    const [body, sig] = token.split(".");
    if (!body || !sig || !same(sig, sign(body))) return false;
    try {
        return Number(JSON.parse(Buffer.from(body, "base64url").toString()).exp) > Date.now();
    } catch {
        return false;
    }
};

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!authRequired()) return next();
    const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    if (m && validToken(m[1])) return next();
    res.status(401).json({ error: "ต้องล็อกอินก่อน" });
}
