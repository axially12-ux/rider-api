import express from "express";
import { router as index } from "./controller/index";
import { router as auth } from "./controller/auth";
import { router as customer } from "./controller/customer";
import { router as order } from "./controller/order";
import { router as routes } from "./controller/routes";
import { router as shop } from "./controller/shop";
import { requireAdmin } from "./middleware/auth";
import cors from "cors";
export const app = express();
// อนุญาตให้หน้าเว็บ (Angular) เรียก API ได้
app.use(cors());
// แปลงข้อมูลรูปแบบ JSON (JSON Body)
app.use(express.json());
app.use("/", index);
app.use("/auth", auth);

// API ของไรเดอร์ (ดูใบงาน / กดส่งเสร็จ) เปิดให้ใช้ได้โดยไม่ต้องล็อกอินเจ้าของร้าน
// ไรเดอร์ยืนยันตัวตนด้วยเลขใบงานแทน
const riderApi = (req: express.Request) =>
    (req.method === "GET" && /^\/rider-job\/[^/]+$/.test(req.path)) ||
    (req.method === "PATCH" && /^\/stops\/\d+\/delivered$/.test(req.path));

// ที่เหลือทั้งหมดเป็นของเจ้าของร้าน ต้องล็อกอิน (ถ้าตั้ง ADMIN_PASSWORD)
app.use("/customer", requireAdmin, customer);
app.use("/order", requireAdmin, order);
app.use("/shop", requireAdmin, shop);
app.use("/routes", (req, res, next) => (riderApi(req) ? next() : requireAdmin(req, res, next)), routes);
