import "dotenv/config";
import { createPool } from "mysql2/promise";


export const conn = createPool({
    connectionLimit: 10,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false }, // Aiven บังคับใช้ SSL (ตั้ง DB_SSL=false ถ้าใช้ MySQL ในเครื่อง)
});

/* ========== Schema (ปรับโครงสร้างตารางอัตโนมัติ) ========== */

// มีคอลัมน์ orders.delivered_at (เวลาที่ส่งจริง) หรือยัง
export const schema = { deliveredAt: false };

// ตรวจและเพิ่มคอลัมน์ delivered_at ตอนเปิดเซิร์ฟเวอร์ (ถ้า DB ไม่อนุญาต ALTER ระบบยังทำงานต่อได้ แต่จะไม่เก็บเวลาส่งจริง)
// ทำเองด้วย SQL ได้ที่ sql/migration.sql
export async function ensureSchema() {
    try {
        const [rows] = await conn.query(
            "SELECT COUNT(*) n FROM information_schema.COLUMNS " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'delivered_at'"
        );
        if (Number((rows as any[])[0].n) === 0) {
            await conn.query("ALTER TABLE orders ADD COLUMN delivered_at DATETIME NULL DEFAULT NULL");
            console.log("เพิ่มคอลัมน์ orders.delivered_at แล้ว");
        }
        schema.deliveredAt = true;
    } catch (e) {
        console.warn("ตรวจ/เพิ่มคอลัมน์ delivered_at ไม่สำเร็จ (ระบบจะไม่เก็บเวลาส่งจริง) — รัน sql/migration.sql เอง:", e instanceof Error ? e.message : e);
    }
}
