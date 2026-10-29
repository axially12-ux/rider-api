import express from "express";
import { conn, schema } from "../dbconnect";
import { Order } from "../model/order";
import { CustomerLike, pickDistinctCustomers } from "../service/customerKey";

export const router = express.Router();

/* ========== Helpers ========== */

// คอลัมน์ที่ใช้แสดงออเดอร์ (ข้อมูลออเดอร์ + ข้อมูลลูกค้า)
const ORDER_COLUMNS =
    "o.id, o.customer_id, o.boxes, o.status, o.created_at, " +
    "c.first_name, c.last_name, c.phone, c.address, c.lat, c.lng";

// ออเดอร์ + ไรเดอร์ที่รับงาน + เวลาส่งจริง (ใช้กับหน้ารายการ/รายละเอียดออเดอร์)
// หาเส้นทางล่าสุดที่ออเดอร์นี้อยู่ แล้วโยงไปถึงไรเดอร์ (ออเดอร์ pending ยังไม่มีไรเดอร์ -> NULL)
// rider_access_code แสดงเฉพาะเมื่อเป็นเลขใบงานปัจจุบันของไรเดอร์ (เลขเก่าถูกแทนที่แล้วจะไม่แสดง)
const selectOrderWithRider = () =>
    `SELECT ${ORDER_COLUMNS}, ` +
    (schema.deliveredAt ? "o.delivered_at, " : "") +
    "IF(o.status='pending', NULL, rt.id) route_id, " +
    "IF(o.status='pending', NULL, rd.id) rider_id, " +
    "IF(o.status='pending', NULL, rd.name) rider_name, " +
    "IF(o.status='pending' OR rt.id <> (SELECT MAX(id) FROM routes WHERE rider_id = rd.id), NULL, rd.access_code) rider_access_code " +
    "FROM orders o JOIN customers c ON c.id = o.customer_id " +
    "LEFT JOIN (SELECT order_id, MAX(route_id) route_id FROM route_stops GROUP BY order_id) lrs ON lrs.order_id = o.id " +
    "LEFT JOIN routes rt ON rt.id = lrs.route_id " +
    "LEFT JOIN riders rd ON rd.id = rt.rider_id";

// ตรวจว่า id เป็นจำนวนเต็มบวก
const validId = (v: string) => Number.isInteger(Number(v)) && Number(v) > 0;

// ตรวจว่าจำนวนกล่องเป็นจำนวนเต็ม 1-3
const validBoxes = (n: number) => Number.isInteger(n) && n >= 1 && n <= 3;

/* ========== READ (GET) ========== */

// แสดงออเดอร์ทั้งหมด   GET /order
router.get("/", async (_req, res) => {
    try {
        const [rows] = await conn.query(selectOrderWithRider() + " ORDER BY o.id");
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
            WHERE distance_km <= 3
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

        const [rows] = await conn.query(selectOrderWithRider() + " WHERE o.id=?", [Number(req.params.id)]);
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
// กติกา: ออเดอร์ที่สุ่มได้ต้องเป็นลูกค้า "คนละชื่อ คนละพิกัด" ทุกใบ และจะไม่สุ่มซ้ำกับลูกค้าที่มีออเดอร์ค้าง (pending) อยู่แล้ว
// ถ้าลูกค้าที่เลือกได้มีน้อยกว่า 20-30 ราย จะสร้างเท่าที่มี (ไม่วนกลับมาซ้ำคนเดิมเพื่อให้ครบจำนวน)
router.post("/simulate", async (_req, res) => {
    try {
        const [customers] = await conn.query(
            "SELECT c.id, c.first_name, c.last_name, c.lat, c.lng, " +
            "EXISTS(SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'pending') AS has_pending " +
            "FROM customers c ORDER BY c.id"
        );
        const all = customers as (CustomerLike & { has_pending: number })[];

        if (!all.length) {
            return res.status(400).json({ error: "ยังไม่มีลูกค้าในระบบ" });
        }

        // คนที่มีออเดอร์ค้างอยู่ = "ใช้ไปแล้ว" ชื่อ/พิกัดของเขาจะไม่ถูกสุ่มซ้ำกับคนอื่นด้วย
        const blocked = all.filter(c => Number(c.has_pending) === 1);
        const candidates = all.filter(c => Number(c.has_pending) !== 1);
        const { picked, skipped } = pickDistinctCustomers(candidates, blocked);

        if (!picked.length) {
            return res.status(409).json({
                error: "ไม่มีลูกค้าที่สุ่มได้ (ทุกคนมีออเดอร์ค้างอยู่แล้ว หรือชื่อ/พิกัดซ้ำกัน) ล้างออเดอร์เดิมหรือแก้ข้อมูลลูกค้าก่อน",
                customers: all.length,
                with_pending_order: blocked.length,
                skipped_duplicates: skipped.length,
            });
        }

        // สลับลำดับแล้วหยิบทีละคน (Fisher-Yates) จึงไม่มีใครถูกเลือกซ้ำ
        const pool = [...picked];
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }

        const requested = 20 + Math.floor(Math.random() * 11);
        const count = Math.min(requested, pool.length);
        const values = pool.slice(0, count).map(c => [c.id, 1 + Math.floor(Math.random() * 3)]); // กล่อง 1-3

        const [result] = await conn.query("INSERT INTO orders(customer_id, boxes) VALUES ?", [values]);
        res.status(201).json({
            affected_row: (result as any).affectedRows,
            requested,
            available_customers: picked.length,
            skipped_duplicates: skipped.length, // ลูกค้าที่ถูกข้ามเพราะชื่อหรือพิกัดซ้ำกับคนอื่น
            skipped_pending: blocked.length,    // ลูกค้าที่ถูกข้ามเพราะมีออเดอร์ค้างอยู่แล้ว
        });
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

        // เก็บ/ล้างเวลาส่งจริงให้ตรงกับสถานะ (แก้เป็น delivered = ส่งเมื่อตอนนี้, แก้กลับ = ล้างเวลา)
        let sql = "UPDATE orders SET boxes=?, status=? WHERE id=?";
        let params: any[] = [boxes, status, id];
        if (schema.deliveredAt) {
            if (status !== "delivered") {
                sql = "UPDATE orders SET boxes=?, status=?, delivered_at=NULL WHERE id=?";
            } else if (!(existing as any).delivered_at) {
                sql = "UPDATE orders SET boxes=?, status=?, delivered_at=? WHERE id=?";
                params = [boxes, status, new Date(), id];
            }
        }
        const [result] = await conn.query(sql, params);
        res.json({ affected_row: (result as any).affectedRows, id });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database operation failed" });
    }
});

/* ========== DELETE ========== */


router.delete("/", async (_req, res) => {
    try {
        const [result] = await conn.query("DELETE FROM orders");
        res.json({ affected_row: (result as any).affectedRows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database operation failed" });
    }
});


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