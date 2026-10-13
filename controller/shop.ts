import express from "express";
import { conn } from "../dbconnect";

export const router = express.Router();

// ดูข้อมูลร้าน (จุดเริ่มต้นของทุกเส้นทาง)   GET /shop
router.get("/", async (_req, res) => {
    try {
        const [rows] = await conn.query("SELECT id,name,lat,lng FROM shop ORDER BY id LIMIT 1");
        res.json((rows as any[])[0] ?? null);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database query failed" });
    }
});

// แก้ชื่อ/พิกัดร้าน (ถ้ายังไม่มีแถวร้านจะสร้างให้)   PUT /shop   body: { name, lat, lng }
router.put("/", async (req, res) => {
    try {
        const name = String(req.body?.name ?? "").trim().slice(0, 100);
        const lat = Number(req.body?.lat);
        const lng = Number(req.body?.lng);
        if (!name) return res.status(400).json({ error: "กรุณากรอกชื่อร้าน" });
        if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
            return res.status(400).json({ error: "พิกัดร้านไม่ถูกต้อง" });
        }

        const [rows] = await conn.query("SELECT id FROM shop ORDER BY id LIMIT 1");
        const shop = (rows as any[])[0];
        if (shop) {
            await conn.query("UPDATE shop SET name=?, lat=?, lng=? WHERE id=?", [name, lat, lng, shop.id]);
        } else {
            await conn.query("INSERT INTO shop(name,lat,lng) VALUES (?,?,?)", [name, lat, lng]);
        }
        res.json({ message: "บันทึกข้อมูลร้านแล้ว", name, lat, lng });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database operation failed" });
    }
});
