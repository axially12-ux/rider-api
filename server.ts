import http from "http";
import { app } from "./app";
import { ensureSchema } from "./dbconnect";

const port = process.env.PORT || 3000;
const server = http.createServer(app);

// ตรวจ/เพิ่มคอลัมน์ในฐานข้อมูลก่อนรับคำขอ (ไม่ว่าสำเร็จหรือไม่ก็เปิดเซิร์ฟเวอร์ต่อ)
ensureSchema().finally(() => {
    server.listen(port, () => {
        console.log("Server is running on port " + port);
    });
});
