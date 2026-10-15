import express from "express";
import { conn } from "../dbconnect";
import { Customer } from "../model/customer";
import { cleanName, nameKey, coordKey } from "../service/customerKey";

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

// หาลูกค้าที่ "ชื่อซ้ำ" หรือ "พิกัดซ้ำ" กับข้อมูลที่กำลังจะบันทึก (excludeId = ตัวเองตอนแก้ไข จะได้ไม่ชนกับตัวเอง)
// ลูกค้าแต่ละคนต้องมีชื่อ+นามสกุลไม่ซ้ำกัน และพิกัดไม่ซ้ำกัน (กติกาอยู่ที่ service/customerKey.ts)
async function findDuplicate(
    c: { first_name: string; last_name: string; lat: number | string; lng: number | string },
    excludeId = 0
): Promise<{ code: "DUPLICATE_NAME" | "DUPLICATE_COORD"; id: number; message: string } | null> {
    // SQL คัดผู้ต้องสงสัยก่อน แล้วให้ JS ตัดสินด้วยกติกาเดียวกับที่ใช้ตอนสุ่มออเดอร์
    const [rows] = await conn.query(
        "SELECT id, first_name, last_name, lat, lng FROM customers WHERE id <> ? AND (" +
        "(LOWER(TRIM(first_name)) = ? AND LOWER(TRIM(last_name)) = ?) OR " +
        "(ROUND(lat, 6) = ROUND(?, 6) AND ROUND(lng, 6) = ROUND(?, 6))) LIMIT 20",
        [excludeId, cleanName(c.first_name).toLowerCase(), cleanName(c.last_name).toLowerCase(), Number(c.lat), Number(c.lng)]
    );
    const list = rows as Customer[];

    const sameName = list.find(r => nameKey(r) === nameKey(c));
    if (sameName) {
        return {
            code: "DUPLICATE_NAME",
            id: sameName.id,
            message: `มีลูกค้าชื่อ "${sameName.first_name} ${sameName.last_name}" อยู่แล้ว (รหัส #${sameName.id}) กรุณาใช้ชื่ออื่น`,
        };
    }
    const sameCoord = list.find(r => coordKey(r) === coordKey(c));
    if (sameCoord) {
        return {
            code: "DUPLICATE_COORD",
            id: sameCoord.id,
            message: `พิกัดนี้มีลูกค้า "${sameCoord.first_name} ${sameCoord.last_name}" (รหัส #${sameCoord.id}) อยู่แล้ว ลูกค้าแต่ละคนต้องมีพิกัดไม่ซ้ำกัน`,
        };
    }
    return null;
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

        // ชื่อหรือพิกัดซ้ำกับลูกค้าที่มีอยู่แล้ว -> ไม่บันทึก
        const dup = await findDuplicate(customer);
        if (dup) {
            return res.status(409).json({ error: dup.message, code: dup.code, duplicate_id: dup.id });
        }

        const sql =
            "INSERT INTO `customers`(`first_name`, `last_name`, `phone`, `address`, `lat`, `lng`) VALUES (?,?,?,?,?,?)";
        const [result] = await conn.query(sql, [
            cleanName(customer.first_name),
            cleanName(customer.last_name),
            customer.phone.trim(),
            customer.address ?? null,
            Number(customer.lat),
            Number(customer.lng),
        ]);

        const insertResult = result as any;
        res.status(201).json({
            affected_row: insertResult.affectedRows,
            last_id: insertResult.insertId,
        });
    } catch (error) {
        // กรณีมี UNIQUE index ในฐานข้อมูล และมีคำขอซ้อนกันสองคำขอผ่านการตรวจด้านบนพร้อมกัน
        if ((error as any)?.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ error: "ชื่อหรือพิกัดนี้มีลูกค้าอยู่แล้ว", code: "DUPLICATE" });
        }
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

        // ตรวจซ้ำเฉพาะเมื่อ "ชื่อหรือพิกัดเปลี่ยนจริง" (แก้แค่เบอร์/ที่อยู่ของลูกค้าเดิมที่ซ้ำอยู่ก่อนแล้วยังทำได้)
        if (nameKey(updated) !== nameKey(existing) || coordKey(updated) !== coordKey(existing)) {
            const dup = await findDuplicate(updated, id);
            if (dup) {
                return res.status(409).json({ error: dup.message, code: dup.code, duplicate_id: dup.id });
            }
        }

        // บันทึกลง DB
        const [result] = await conn.query(
            "UPDATE customers SET first_name=?, last_name=?, phone=?, address=?, lat=?, lng=? WHERE id=?",
            [
                cleanName(updated.first_name),
                cleanName(updated.last_name),
                updated.phone.trim(),
                updated.address ?? null,
                Number(updated.lat),
                Number(updated.lng),
                id,
            ]
        );

        res.json({ affected_row: (result as any).affectedRows, id });
    } catch (error) {
        if ((error as any)?.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ error: "ชื่อหรือพิกัดนี้มีลูกค้าอยู่แล้ว", code: "DUPLICATE" });
        }
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