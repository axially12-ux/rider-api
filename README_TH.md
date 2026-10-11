# Rider API (TypeScript + Express + MySQL)

โครงสร้างจัดตามตัวอย่างที่เรียน: แยก `app.ts`, `server.ts`, `dbconnect.ts`, โฟลเดอร์ `controller/` สำหรับ API และ `model/` สำหรับชนิดข้อมูล

## โครงสร้างไฟล์

```text
rider-api/
├── app.ts                  # ตั้งค่า Express และเรียกใช้ routes
├── server.ts               # เปิดเซิร์ฟเวอร์
├── dbconnect.ts            # ตั้งค่าการเชื่อมต่อ MySQL โดยตรง
├── controller/             # แยก API ตามหน้าที่
│   ├── index.ts             # หน้าแรกและ health check
│   ├── customer.ts          # API ลูกค้า
│   ├── order.ts             # API ออเดอร์
│   └── routes.ts            # คำนวณและจัดการเส้นทางไรเดอร์
├── model/                  # interface ของข้อมูล
│   ├── customer.ts
│   └── order.ts
├── package.json
└── tsconfig.json
```

## เริ่มต้นใช้งาน
## วิธีรันโปรเจกต์
เปิด Terminal ในโฟลเดอร์เดียวกับ `package.json` แล้วรัน:

## เส้นทาง API หลัก
## Customer
```bash
- GET https://rider-api-4gww.onrender.com/customer — ดูรายชื่อลูกค้าทั้งหมด
- GET https://rider-api-4gww.onrender.com/customer/1 — ดูลูกค้าตาม ID
- GET https://rider-api-4gww.onrender.com/customer/search/fields?name=สม — ค้นหาจากชื่อหรือนามสกุล
- GET https://rider-api-4gww.onrender.com/customer/nearby?lat=16.2467&lng=103.2528 — ค้นลูกค้าในรัศมี 1 กม.
- POST https://rider-api-4gww.onrender.com/customer — เพิ่มลูกค้า
- PUT https://rider-api-4gww.onrender.com/customer/1 — แก้ไขลูกค้า
- DELETE https://rider-api-4gww.onrender.com/customer/1 — ลบลูกค้า
```
## Order
```bash
- GET https://rider-api-4gww.onrender.com/order — ดูออเดอร์ทั้งหมด
- GET https://rider-api-4gww.onrender.com/order/1 — ดูออเดอร์ตาม ID
- GET https://rider-api-4gww.onrender.com/order/nearby?lat=16.2467&lng=103.2528 — ค้นออเดอร์ในรัศมี 2 กม.
- POST https://rider-api-4gww.onrender.com/order — เพิ่มออเดอร์
- POST https://rider-api-4gww.onrender.com/order/simulate — สร้างออเดอร์ตัวอย่าง 20–30 รายการ
- PUT https://rider-api-4gww.onrender.com/order/1 — แก้ไขจำนวนกล่อง/สถานะ
- DELETE https://rider-api-4gww.onrender.com/order/1 — ลบออเดอร์ 1 รายการ
- DELETE https://rider-api-4gww.onrender.com/order — ลบออเดอร์ทั้งหมด (ใช้ทดสอบเท่านั้น)
```

## Route
```bash
- POST https://rider-api-4gww.onrender.com/routes/calculate — พรีวิวการจัดเส้นทาง (ยังไม่บันทึก)
- POST https://rider-api-4gww.onrender.com/routes/recalculate — บันทึกการมอบหมายเส้นทาง
- GET https://rider-api-4gww.onrender.com/routes — ดูเส้นทางที่บันทึกแล้วทั้งหมด
- GET https://rider-api-4gww.onrender.com/routes/1 — ดูเส้นทาง 1 เส้นพร้อมจุดส่ง
- GET https://rider-api-4gww.onrender.com/routes/rider-job/R001 — ไรเดอร์ดูงานด้วย access code
- PATCH https://rider-api-4gww.onrender.com/routes/stops/1/delivered — ไรเดอร์กดส่งของเสร็จ
```
## หมายเหตุ
- คำสั่ง SQL ใช้ placeholder `?` สำหรับค่าที่รับมาจาก request เพื่อลดความเสี่ยง SQL injection
- ค่ารหัสผ่านฐานข้อมูลอยู่ใน `dbconnect.ts` ตามที่ต้องการไม่ใช้ `.env` ควรเก็บไฟล์นี้ให้ปลอดภัยและอย่าเผยแพร่ขึ้น GitHub
- ระยะทางคำนวณจากพิกัดเส้นตรง (Haversine) ไม่ใช่ระยะทางถนนจริง

หากขึ้น `Missing script: "dev"` ให้ตรวจสอบว่า Terminal อยู่ในโฟลเดอร์โปรเจกต์ที่ถูกต้อง และเปิด `package.json` ดูว่ามี `"dev": "ts-node-dev --respawn --transpile-only server.ts"` อยู่ภายใต้ `scripts` หรือไม่


