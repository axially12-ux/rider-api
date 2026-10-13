import express from "express";
import { authRequired, checkPassword, issueToken } from "../middleware/auth";

export const router = express.Router();

// หน้าเว็บถามว่าต้องล็อกอินไหม   GET /auth/status
router.get("/status", (_req, res) => res.json({ required: authRequired() }));

// กันเดารหัส: ผิดเกิน 8 ครั้งต่อ 10 นาทีต่อ IP จะถูกบล็อกชั่วคราว
const attempts = new Map<string, { n: number; reset: number }>();

// ล็อกอิน   POST /auth/login   body: { password }
router.post("/login", (req, res) => {
    if (!authRequired()) return res.json({ token: "", expires_in: 0 });

    const ip = req.ip || "unknown";
    const now = Date.now();
    const rec = attempts.get(ip);
    if (rec && rec.reset > now && rec.n >= 8) {
        return res.status(429).json({ error: "ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่" });
    }
    if (!checkPassword(req.body?.password)) {
        attempts.set(ip, rec && rec.reset > now ? { n: rec.n + 1, reset: rec.reset } : { n: 1, reset: now + 10 * 60 * 1000 });
        return res.status(401).json({ error: "รหัสผ่านไม่ถูกต้อง" });
    }
    attempts.delete(ip);
    res.json(issueToken());
});
