import express from "express";
import { conn } from "../dbconnect";
import { Customer } from "../model/customer";

export const router = express.Router();

/* ========== Helpers ========== */

// ตรวจว่า id เป็นจำนวนเต็มบวก
function isValidId(id: number): boolean {
    return Number.isInteger(id) && id >= 1;
}

// ตรวจข้อมูลลูกค้า (ชื่อ นามสกุล เบอร์ ต้องไม่ว่าง, lat/lng ต้องอยู่ในช่วงที่ถูกต้อง)
function isValidCustomer(c: Partial<Customer>): boolean {
    const lat = Number(c.lat);
    const lng = Number(c.lng);

    return (
        typeof c.first_name === "string" && c.first_name.trim() !== "" &&
        typeof c.last_name === "string" && c.last_name.trim() !== "" &&
        typeof c.phone === "string" && c.phone.trim() !== "" &&
        Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
        Number.isFinite(lng) && lng >= -180 && lng <= 180
    );
}

/* ========== READ (GET) ========== */

// แสดงลูกค้าทั้งหมด   GET /customer
router.get("/", async (_req, res) => {
    try {
        const [rows] = await conn.query("SELECT * FROM customers ORDER BY id");
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database query failed" });
    }
});

// ค้นหาจากส่วนหนึ่งของชื่อหรือนามสกุล   GET /customer/search/fields?name=สม
router.get("/search/fields", async (req, res) => {
    try {
        if (typeof req.query.name !== "string" || !req.query.name.trim()) {
            return res.status(400).json({ error: "Query parameter name is required" });
        }

        const keyword = "%" + req.query.name.trim() + "%";
        const [rows] = await conn.query(
            "SELECT * FROM customers WHERE first_name LIKE ? OR last_name LIKE ?",
            [keyword, keyword]
        );
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ค้นลูกค้าในรัศมี 1 กม. จากพิกัดที่กำหนด   GET /customer/nearby?lat=16.2467&lng=103.2528
router.get("/nearby", async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);

        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({ error: "ต้องส่ง lat และ lng เป็นตัวเลข" });
        }

        // สูตร Haversine คำนวณระยะทางเป็นกิโลเมตร
        const sql = `
            SELECT * FROM (
                SELECT *,
                    (6371 * ACOS(LEAST(1,
                        COS(RADIANS(?)) * COS(RADIANS(lat)) * COS(RADIANS(lng) - RADIANS(?))
                        + SIN(RADIANS(?)) * SIN(RADIANS(lat))
                    ))) AS distance_km
                FROM customers
            ) t
            WHERE distance_km <= 1
            ORDER BY distance_km
        `;
        const [rows] = await conn.query(sql, [lat, lng, lat]);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// แสดงลูกค้า 1 คน   GET /customer/1  (ต้องอยู่หลัง /nearby และ /search/fields)
router.get("/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!isValidId(id)) {
            return res.status(400).json({ error: "Invalid customer id" });
        }

        const [rows] = await conn.query("SELECT * FROM customers WHERE id = ?", [id]);
        const list = rows as Customer[];

        if (!list.length) {
            return res.status(404).json({ error: "Customer not found" });
        }
        res.json(list[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database query failed" });
    }
});

/* ========== CREATE (POST) ========== */

// เพิ่มลูกค้า   POST /customer
router.post("/", async (req, res) => {
    try {
        const customer: Customer = req.body;

        if (!customer || !isValidCustomer(customer)) {
            return res.status(400).json({
                error: "Required: first_name, last_name, phone, valid lat and lng",
            });
        }

        const sql =
            "INSERT INTO `customers`(`first_name`, `last_name`, `phone`, `address`, `lat`, `lng`) VALUES (?,?,?,?,?,?)";
        const [result] = await conn.query(sql, [
            customer.first_name,
            customer.last_name,
            customer.phone,
            customer.address,
            customer.lat,
            customer.lng,
        ]);

        const insertResult = result as any;
        res.status(201).json({
            affected_row: insertResult.affectedRows,
            last_id: insertResult.insertId,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database operation failed" });
    }
});

/* ========== UPDATE (PUT) ========== */

// แก้ไขลูกค้า (ส่งเฉพาะฟิลด์ที่จะแก้ได้)   PUT /customer/1
router.put("/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!isValidId(id)) {
            return res.status(400).json({ error: "Invalid customer id" });
        }

        // ดึงข้อมูลเดิมมาก่อน
        const [rows] = await conn.query("SELECT * FROM customers WHERE id = ?", [id]);
        const existing = (rows as Customer[])[0];
        if (!existing) {
            return res.status(404).json({ error: "Customer not found" });
        }

        // เอาข้อมูลใหม่ทับข้อมูลเดิม แล้วตรวจสอบ
        const body = req.body as Partial<Customer>;
        const updated = { ...existing, ...body };

        if (!isValidCustomer(updated)) {
            return res.status(400).json({
                error: "Invalid customer data; name, phone, lat and lng are required",
            });
        }

        // บันทึกลง DB
        const [result] = await conn.query(
            "UPDATE customers SET first_name=?, last_name=?, phone=?, address=?, lat=?, lng=? WHERE id=?",
            [
                updated.first_name.trim(),
                updated.last_name.trim(),
                updated.phone.trim(),
                updated.address ?? null,
                Number(updated.lat),
                Number(updated.lng),
                id,
            ]
        );

        res.json({ affected_row: (result as any).affectedRows, id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Database operation failed" });
    }
});

/* ========== DELETE ========== */

// ลบลูกค้า   DELETE /customer/1
router.delete("/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!isValidId(id)) {
            return res.status(400).json({ error: "Invalid customer id" });
        }

        const [result] = await conn.query("DELETE FROM customers WHERE id = ?", [id]);
        const deleteResult = result as any;

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ error: "Customer not found" });
        }
        res.status(200).json({ affected_row: deleteResult.affectedRows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});