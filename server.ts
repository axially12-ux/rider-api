import http from "http";
import { app } from "./app";
// ใช้ PORT ตัวพิมพ์ใหญ่ตามมาตรฐานสากล (เพราะพวกบริการโฮสติ้ง เช่น Render จะส่งค่ามาเป็นตัวพิมพ์ใหญ่เท่านั้น)
const port = process.env.PORT || 3000;
const server = http.createServer(app);
server.listen(port, () => {
    console.log(`Server is started on port ${port}`);
}).on("error", (error) => {
    console.error(error);
});

