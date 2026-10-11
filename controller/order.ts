import express from "express";
import { conn } from "../dbconnect";
import { Order } from "../model/order";

export const router = express.Router();

/* ========== Helpers ========== */

// คอลัมน์ที่ใช้แสดงออเดอร์ (ข้อมูลออเดอร์ + ข้อมูลลูกค้า)
const ORDER_COLUMNS =
    "o.id, o.customer_id, o.boxes, o.status, o.created_at, " +
    "c.first_name, c.last_name, c.phone, c.address, c.lat, c.lng";

// SQL พื้นฐานสำหรับดึงออเดอร์ JOIN ลูกค้า
const SELECT_ORDER =
    `SELECT ${ORDER_COLUMNS} FROM orders o JOIN customers c ON c.id = o.customer_id`;

// ตรวจว่า id เป็นจำนวนเต็มบวก
const validId = (v: string) => Number.isInteger(Number(v)) && Number(v) > 0;

// ตรวจว่าจำนวนกล่องเป็นจำนวนเต็ม 1-3
const validBoxes = (n: number) => Number.isInteger(n) && n >= 1 && n <= 3;

/* ========== READ (GET) ========== */

// แสดงออเดอร์ทั้งหมด   GET /order
router.get("/", async (_req, res) => {
    try {
        const [rows] = await conn.query(SELECT_ORDER + " ORDER BY o.id");
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database query failed" });
    }
});

// ค้นออเดอร์ในรัศมี 2 กม. จากพิกัดที่กำหนด   GET /order/nearby?lat=16.2467&lng=103.2528
router.get("/nearby", async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);

        if (
            req.query.lat === undefined || req.query.lng === undefined ||
            !Number.isFinite(lat) || !Number.isFinite(lng) ||
            Math.abs(lat) > 90 || Math.abs(lng) > 180
        ) {
            return res.status(400).json({ error: "ต้องส่ง lat/lng ที่ถูกต้อง" });
        }

        // สูตร Haversine คำนวณระยะทางเป็นกิโลเมตร
        const sql = `
            SELECT * FROM (
                SELECT ${ORDER_COLUMNS},
                    (6371 * ACOS(LEAST(1, GREATEST(-1,
                        COS(RADIANS(?)) * COS(RADIANS(c.lat)) * COS(RADIANS(c.lng) - RADIANS(?))
                        + SIN(RADIANS(?)) * SIN(RADIANS(c.lat))
                    )))) AS distance_km
                FROM orders o
                JOIN customers c ON c.id = o.customer_id
            ) t
            WHERE distance_km <= 2
            ORDER BY distance_km
        `;
        const [rows] = await conn.query(sql, [lat, lng, lat]);
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database query failed" });
    }
});

// แสดงออเดอร์ 1 รายการ   GET /order/1  (ต้องอยู่หลัง /nearby)
router.get("/:id", async (req, res) => {
    try {
        if (!validId(req.params.id)) {
            return res.status(400).json({ error: "Invalid order id" });
        }

        const [rows] = await conn.query(SELECT_ORDER + " WHERE o.id=?", [Number(req.params.id)]);
        const list = rows as Order[];

        if (!list.length) {
            return res.status(404).json({ error: "Order not found" });
        }
        res.json(list[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database query failed" });
    }
});

/* ========== CREATE (POST) ========== */

// สร้างออเดอร์สุ่ม 20-30 รายการ ไว้ทดสอบ   POST /order/simulate
router.post("/simulate", async (_req, res) => {
    try {
        const [customers] = await conn.query("SELECT id FROM customers");
        const ids = (customers as any[]).map(c => c.id);

        if (!ids.length) {
            return res.status(400).json({ error: "ยังไม่มีลูกค้าในระบบ" });
        }

        // สุ่มจำนวนออเดอร์ 20-30 รายการ แต่ละรายการสุ่มจำนวนกล่อง 1-3
        // สุ่มลูกค้า "ไม่ซ้ำกัน" ในรอบเดียว (สลับลำดับแล้วหยิบทีละคน)
        // จะวนกลับมาซ้ำก็ต่อเมื่อจำนวนลูกค้ามีน้อยกว่าจำนวนออเดอร์ที่จะสร้าง
        const shuffle = (a: number[]) => {
            const r = [...a];
            for (let i = r.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [r[i], r[j]] = [r[j], r[i]];
            }
            return r;
        };
        const count = 20 + Math.floor(Math.random() * 11);
        const values: number[][] = [];
        let pool: number[] = [];
        for (let i = 0; i < count; i++) {
            if (!pool.length) pool = shuffle(ids);
            values.push([pool.pop() as number, 1 + Math.floor(Math.random() * 3)]);
        }

        const [result] = await conn.query("INSERT INTO orders(customer_id, boxes) VALUES ?", [values]);
        res.status(201).json({ affected_row: (result as any).affectedRows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database operation failed" });
    }
});

// เพิ่มออเดอร์   POST /order   body: { customer_id, boxes }
router.post("/", async (req, res) => {
    try {
        const customerId = Number(req.body?.customer_id);
        const boxes = Number(req.body?.boxes);

        if (!Number.isInteger(customerId) || customerId < 1) {
            return res.status(400).json({ error: "customer_id must be a positive integer" });
        }
        if (!validBoxes(boxes)) {
            return res.status(400).json({ error: "boxes must be an integer from 1 to 3" });
        }

        const [result] = await conn.query(
            "INSERT INTO orders(customer_id,boxes) VALUES (?,?)",
            [customerId, boxes]
        );
        const r = result as any;
        res.status(201).json({ affected_row: r.affectedRows, last_id: r.insertId });
    } catch (e: any) {
        // customer_id ที่ส่งมาไม่มีอยู่ในตาราง customers
        if (e?.code === "ER_NO_REFERENCED_ROW_2") {
            return res.status(400).json({ error: "Customer does not exist" });
        }
        console.error(e);
        res.status(500).json({ error: "Database operation failed" });
    }
});

/* ========== UPDATE (PUT) ========== */

// แก้ไขจำนวนกล่อง/สถานะ (ส่งเฉพาะฟิลด์ที่จะแก้ได้)   PUT /order/1
router.put("/:id", async (req, res) => {
    try {
        if (!validId(req.params.id)) {
            return res.status(400).json({ error: "Invalid order id" });
        }
        const id = Number(req.params.id);

        // ดึงข้อมูลเดิมมาก่อน
        const [rows] = await conn.query("SELECT * FROM orders WHERE id=?", [id]);
        const existing = (rows as Order[])[0];
        if (!existing) {
            return res.status(404).json({ error: "Order not found" });
        }

        // ถ้าไม่ได้ส่งฟิลด์ไหนมา ใช้ค่าเดิม
        const boxes = req.body?.boxes === undefined ? existing.boxes : Number(req.body.boxes);
        const status = req.body?.status === undefined ? existing.status : req.body.status;

        if (!validBoxes(boxes)) {
            return res.status(400).json({ error: "boxes must be an integer from 1 to 3" });
        }
        if (!["pending", "assigned", "delivered"].includes(status)) {
            return res.status(400).json({ error: "status must be pending, assigned, or delivered" });
        }

        const [result] = await conn.query(
            "UPDATE orders SET boxes=?, status=? WHERE id=?",
            [boxes, status, id]
        );
        res.json({ affected_row: (result as any).affectedRows, id });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database operation failed" });
    }
});

/* ========== DELETE ========== */

// ลบออเดอร์ทั้งหมด (อันตราย! ใช้ล้างข้อมูลทดสอบเท่านั้น)   DELETE /order
router.delete("/", async (_req, res) => {
    try {
        const [result] = await conn.query("DELETE FROM orders");
        res.json({ affected_row: (result as any).affectedRows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database operation failed" });
    }
});

// ลบออเดอร์ 1 รายการ   DELETE /order/1
router.delete("/:id", async (req, res) => {
    try {
        if (!validId(req.params.id)) {
            return res.status(400).json({ error: "Invalid order id" });
        }

        const [result] = await conn.query("DELETE FROM orders WHERE id=?", [Number(req.params.id)]);
        const n = (result as any).affectedRows;

        if (!n) {
            return res.status(404).json({ error: "Order not found" });
        }
        res.json({ affected_row: n });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database operation failed" });
    }
});