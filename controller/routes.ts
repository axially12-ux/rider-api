import express from "express";
import { conn } from "../dbconnect";

export const router = express.Router();

/* ========== Config (ค่าคงที่ของระบบ) ========== */

const MAX_ORDERS_PER_RIDER = 3;       // ไรเดอร์หนึ่งคนรับได้สูงสุดกี่ออเดอร์
const SPEED_KMH = 25;                 // ความเร็วเฉลี่ยของไรเดอร์ (กม./ชม.)
const SERVICE_MINUTES_PER_STOP = 3;   // เวลาส่งของต่อ 1 จุด (นาที)
const FOOD_COST_PER_BOX = 40;         // ต้นทุนอาหารต่อกล่อง
const PRICE_PER_BOX = 65;             // ราคาขายต่อกล่อง
const TRIP_FEE = 15;                  // ค่าเที่ยวพื้นฐานของไรเดอร์
const RIDER_RATE_PER_BOX_KM = 2;      // ค่าตอบแทนไรเดอร์ต่อ (กล่อง x กม.)

/* ========== Helpers ========== */

type Point = {
    lat: number;
    lng: number;
};

// SQL ดึงจุดส่งของในเส้นทาง (ใช้ทั้งหน้าดูเส้นทางและหน้าไรเดอร์)
const SELECT_STOPS =
    "SELECT rs.seq, o.id order_id, o.boxes, o.status, " +
    "c.first_name, c.last_name, c.phone, c.address, c.lat, c.lng " +
    "FROM route_stops rs " +
    "JOIN orders o ON o.id = rs.order_id " +
    "JOIN customers c ON c.id = o.customer_id " +
    "WHERE rs.route_id = ? ORDER BY rs.seq";

// แปลงแถวจาก DB (lat/lng อาจเป็น string) ให้เป็น Point ที่เป็นตัวเลข
const toPoint = (row: { lat: any; lng: any }): Point => ({
    lat: Number(row.lat),
    lng: Number(row.lng),
});

// ระยะทางเส้นตรงระหว่าง 2 จุด (กม.) ด้วยสูตร Haversine
const distanceKm = (a: Point, b: Point) => {
    const rad = (n: number) => (n * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
};

// หาลำดับส่งที่ระยะรวมสั้นที่สุด โดยลองทุกการเรียงสับเปลี่ยน (ใช้ได้เพราะแต่ละคนมีไม่เกิน 3 จุด)
function findBestStopOrder(points: Point[], start: Point) {
    let bestKm = Infinity;
    let bestSeq: number[] = [];

    const permute = (picked: number[], left: number[]) => {
        // เรียงครบทุกจุดแล้ว -> คำนวณระยะรวมจากร้านผ่านทุกจุดตามลำดับ
        if (!left.length) {
            let d = 0;
            let prev = start;
            for (const i of picked) {
                d += distanceKm(prev, points[i]);
                prev = points[i];
            }
            if (d < bestKm) {
                bestKm = d;
                bestSeq = [...picked];
            }
            return;
        }
        for (let i = 0; i < left.length; i++) {
            permute([...picked, left[i]], [...left.slice(0, i), ...left.slice(i + 1)]);
        }
    };

    permute([], points.map((_, i) => i));
    return { km: bestKm, order: bestSeq };
}

// ค่าตอบแทนไรเดอร์ = ค่าเที่ยว + (กม. x อัตรา x จำนวนกล่อง)
const calcRiderCost = (km: number, boxes: number) =>
    TRIP_FEE + km * RIDER_RATE_PER_BOX_KM * boxes;

// เวลาถึงโดยประมาณ (HH:MM) นับจากเริ่มออกส่ง 11:30
const formatArrival = (minutes: number) => {
    const total = 11 * 60 + 30 + minutes;
    const hh = Math.floor(total / 60).toString().padStart(2, "0");
    const mm = Math.floor(total % 60).toString().padStart(2, "0");
    return `${hh}:${mm}`;
};

/* ========== CALCULATE (คำนวณเส้นทาง ยังไม่บันทึก) ========== */

// พรีวิวการจัดเส้นทาง (ใช้เฉพาะออเดอร์ pending)   POST /route/calculate
router.post("/calculate", async (req, res) => {
    try {
        // ดึงพิกัดร้าน
        const [shops] = await conn.query("SELECT id,name,lat,lng FROM shop ORDER BY id LIMIT 1");
        const shop = (shops as any[])[0];
        if (!shop) {
            return res.status(400).json({ error: "กรุณาเพิ่มพิกัดร้านในตาราง shop ก่อน" });
        }
        const shopPoint = toPoint(shop);

        // ดึงออเดอร์ที่ยังไม่ได้จัด และรายชื่อไรเดอร์
        const [orders] = await conn.query(
            "SELECT o.id,o.customer_id,o.boxes,c.first_name,c.last_name,c.phone,c.address,c.lat,c.lng " +
            "FROM orders o JOIN customers c ON c.id=o.customer_id " +
            "WHERE o.status='pending' ORDER BY o.id"
        );
        const [riders] = await conn.query("SELECT id,name,phone FROM riders ORDER BY id");
        const pending = orders as any[];
        const available = riders as any[];

        // ไม่มีออเดอร์ให้จัด -> ตอบผลว่างพร้อมสรุปเป็น 0
        if (!pending.length) {
            return res.json({
                message: "ไม่มีออเดอร์ pending สำหรับจัดเส้นทาง",
                routes: [],
                unassigned: [],
                summary: {
                    orders: 0,
                    riders: 0,
                    total_km: 0,
                    total_rider_cost: 0,
                    revenue: 0,
                    food_cost: 0,
                    profit_before_other_expenses: 0,
                },
            });
        }
        if (!available.length) {
            return res.status(400).json({ error: "ยังไม่มีไรเดอร์ในระบบ" });
        }

        // ขั้นที่ 1: จัดออเดอร์ให้ไรเดอร์แบบ greedy
        // วนทีละออเดอร์ (เรียงจากใกล้ร้านไปไกล) แล้วให้ไรเดอร์ที่ทำให้ระยะรวมเพิ่มน้อยที่สุด
        const plans = available.map(r => ({
            rider: r,
            orders: [] as any[],
            km: 0,
            stops: [] as any[],
        }));
        const remaining = [...pending].sort((a, b) => distanceKm(shopPoint, toPoint(a)) - distanceKm(shopPoint, toPoint(b)));

        for (const order of remaining) {
            let choice: any = null;
            let choiceKm = Infinity;

            for (const p of plans) {
                if (p.orders.length >= MAX_ORDERS_PER_RIDER) continue; // เต็มแล้วข้าม

                const candidate = [...p.orders, order];
                const opt = findBestStopOrder(candidate.map(toPoint), shopPoint);
                if (opt.km < choiceKm) {
                    choice = p;
                    choiceKm = opt.km;
                }
            }

            if (!choice) continue; // ไรเดอร์เต็มทุกคน -> ออเดอร์นี้จะไปอยู่ใน unassigned
            choice.orders.push(order);
            choice.km = choiceKm;
        }

        // ออเดอร์ที่จัดไม่ได้ (ไรเดอร์ไม่พอ)
        const unassigned = pending.filter(o => !plans.some(p => p.orders.some(x => x.id === o.id)));

        // ขั้นที่ 2: ของไรเดอร์ที่ได้งาน หาลำดับส่งที่ดีที่สุด แล้วคำนวณต้นทุน/กำไร
        const routes = plans.filter(p => p.orders.length).map(p => {
            const opt = findBestStopOrder(p.orders.map(toPoint), shopPoint);

            // สร้างรายการจุดส่งตามลำดับ พร้อมระยะทางแต่ละช่วง
            let previous: Point = shopPoint;
            p.stops = opt.order.map((idx, i) => {
                const o = p.orders[idx];
                const point = toPoint(o);
                const leg = distanceKm(previous, point);
                previous = point;
                return {
                    seq: i + 1,
                    order_id: o.id,
                    customer_id: o.customer_id,
                    customer_name: `${o.first_name} ${o.last_name}`,
                    phone: o.phone,
                    address: o.address,
                    lat: point.lat,
                    lng: point.lng,
                    boxes: Number(o.boxes),
                    leg_km: Number(leg.toFixed(2)),
                };
            });

            const km = opt.km;
            const boxes = p.orders.reduce((s, o) => s + Number(o.boxes), 0);
            const riderCost = calcRiderCost(km, boxes);
            const revenue = boxes * PRICE_PER_BOX;
            const foodCost = boxes * FOOD_COST_PER_BOX;
            const minutes = (km / SPEED_KMH) * 60 + p.orders.length * SERVICE_MINUTES_PER_STOP;

            return {
                rider_id: p.rider.id,
                rider_name: p.rider.name,
                orders_count: p.orders.length,
                total_boxes: boxes,
                total_km: Number(km.toFixed(2)),
                estimated_minutes: Number(minutes.toFixed(1)),
                estimated_arrival: formatArrival(minutes),
                rider_cost: Number(riderCost.toFixed(2)),
                revenue,
                food_cost: foodCost,
                profit_before_other_expenses: Number((revenue - foodCost - riderCost).toFixed(2)),
                stops: p.stops,
            };
        });

        // รวมค่าตัวเลขของทุกเส้นทางตาม key ที่ระบุ
        const sum = (key: string) => routes.reduce((s: any, r: any) => s + Number(r[key] || 0), 0);

        res.json({
            method: "greedy assignment + exact stop order within each route; distances are straight-line estimates, not road routing",
            shop,
            settings: {
                max_orders_per_rider: MAX_ORDERS_PER_RIDER,
                estimated_speed_kmh: SPEED_KMH,
                service_minutes_per_stop: SERVICE_MINUTES_PER_STOP,
                delivery_window: "11:30–12:30",
            },
            routes,
            unassigned: unassigned.map(o => ({
                order_id: o.id,
                reason: "จำนวนไรเดอร์ไม่เพียงพอ (ไรเดอร์หนึ่งคนรับได้ไม่เกิน 3 ออเดอร์)",
            })),
            summary: {
                orders_assigned: routes.reduce((s, r) => s + r.orders_count, 0),
                orders_unassigned: unassigned.length,
                riders_used: routes.length,
                total_km: Number(sum("total_km").toFixed(2)),
                total_rider_cost: Number(sum("rider_cost").toFixed(2)),
                revenue: sum("revenue"),
                food_cost: sum("food_cost"),
                profit_before_other_expenses: Number(sum("profit_before_other_expenses").toFixed(2)),
                within_one_hour: routes.every(r => r.estimated_minutes <= 60),
            },
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({
            error: "คำนวณเส้นทางไม่สำเร็จ",
            detail: e instanceof Error ? e.message : "unknown error",
        });
    }
});

/* ========== SAVE (บันทึกเส้นทางลง DB) ========== */

// บันทึกเส้นทางและมอบหมายออเดอร์ (ใช้ transaction ถ้าพลาดจุดไหนจะไม่บันทึกอะไรเลย)   POST /route/recalculate
// body: { assignments: [{ rider_id, order_ids: [...] }] }
router.post("/recalculate", async (req, res) => {
    const cx = await conn.getConnection();
    try {
        await cx.beginTransaction();

        // รับรายการที่จะบันทึกจาก request เท่านั้น (ไม่คำนวณใหม่เอง) และตรวจสอบก่อนบันทึก
        const assignments = req.body?.assignments;
        if (!Array.isArray(assignments) || !assignments.length) {
            await cx.rollback();
            return res.status(400).json({ error: "ส่ง assignments เป็นรายการ {rider_id, order_ids:[...]} ที่ต้องการบันทึก" });
        }

        // ตรวจรูปแบบ: ไรเดอร์แต่ละคนมี order_ids 1-3 รายการ และห้ามมี order_id ซ้ำกัน
        const seen = new Set<number>();
        for (const a of assignments) {
            if (
                !Number.isInteger(Number(a.rider_id)) ||
                !Array.isArray(a.order_ids) ||
                a.order_ids.length < 1 ||
                a.order_ids.length > MAX_ORDERS_PER_RIDER
            ) {
                await cx.rollback();
                return res.status(400).json({ error: "แต่ละไรเดอร์ต้องมี order_ids 1–3 รายการ" });
            }
            for (const raw of a.order_ids) {
                const id = Number(raw);
                if (!Number.isInteger(id) || id < 1 || seen.has(id)) {
                    await cx.rollback();
                    return res.status(400).json({ error: "order_id ไม่ถูกต้องหรือซ้ำกัน" });
                }
                seen.add(id);
            }
        }

        // ล็อกแถวออเดอร์ (FOR UPDATE) และตรวจว่ามีครบและยังเป็น pending ทั้งหมด
        const [orderRows] = await cx.query(
            `SELECT id,status FROM orders WHERE id IN (${[...seen].map(() => "?").join(",")}) FOR UPDATE`,
            [...seen]
        );
        if ((orderRows as any[]).length !== seen.size || (orderRows as any[]).some(o => o.status !== "pending")) {
            await cx.rollback();
            return res.status(409).json({ error: "มีออเดอร์ไม่พบหรือไม่ได้อยู่สถานะ pending; ไม่มีการบันทึก" });
        }

        // ตรวจว่า rider_id ทุกตัวมีอยู่จริง
        const [riderRows] = await cx.query(
            `SELECT id FROM riders WHERE id IN (${assignments.map(() => "?").join(",")})`,
            assignments.map(a => Number(a.rider_id))
        );
        if ((riderRows as any[]).length !== new Set(assignments.map(a => Number(a.rider_id))).size) {
            await cx.rollback();
            return res.status(400).json({ error: "พบ rider_id ที่ไม่มีในระบบ" });
        }

        // ดึงพิกัดร้าน
        const [shops] = await cx.query("SELECT lat,lng FROM shop ORDER BY id LIMIT 1");
        const shop = (shops as any[])[0];
        if (!shop) {
            await cx.rollback();
            return res.status(400).json({ error: "ยังไม่มีพิกัดร้าน" });
        }
        const shopPoint = toPoint(shop);

        // วนบันทึกทีละไรเดอร์: หาลำดับส่งที่ดีที่สุด -> สร้าง route -> สร้างจุดส่ง -> เปลี่ยนสถานะเป็น assigned
        const output = [];
        for (const a of assignments) {
            const ids = a.order_ids.map(Number);
            const [rows] = await cx.query(
                `SELECT o.id,o.boxes,c.lat,c.lng FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id IN (${ids.map(() => "?").join(",")})`,
                ids
            );
            const byId = new Map((rows as any[]).map(o => [o.id, o]));
            const points = ids.map((id: number) => byId.get(id) as any);

            const opt = findBestStopOrder(points.map(toPoint), shopPoint);
            const ordered = opt.order.map(i => points[i]);
            const boxes = ordered.reduce((s, o) => s + Number(o.boxes), 0);
            const cost = calcRiderCost(opt.km, boxes);

            const [routeResult] = await cx.query(
                "INSERT INTO routes(rider_id,total_km,total_cost) VALUES(?,?,?)",
                [Number(a.rider_id), Number(opt.km.toFixed(2)), Number(cost.toFixed(2))]
            );
            const routeId = (routeResult as any).insertId;

            for (let i = 0; i < ordered.length; i++) {
                await cx.query(
                    "INSERT INTO route_stops(route_id,order_id,seq) VALUES(?,?,?)",
                    [routeId, ordered[i].id, i + 1]
                );
                await cx.query("UPDATE orders SET status='assigned' WHERE id=?", [ordered[i].id]);
            }

            output.push({
                route_id: routeId,
                rider_id: Number(a.rider_id),
                order_ids: ordered.map(o => o.id),
                total_km: Number(opt.km.toFixed(2)),
                total_cost: Number(cost.toFixed(2)),
            });
        }

        await cx.commit();
        res.status(201).json({ message: "บันทึกเส้นทางและมอบหมายออเดอร์สำเร็จ", routes: output });
    } catch (e) {
        await cx.rollback();
        console.error(e);
        res.status(500).json({
            error: "บันทึกเส้นทางไม่สำเร็จ",
            detail: e instanceof Error ? e.message : "unknown error",
        });
    } finally {
        cx.release(); // คืน connection กลับ pool เสมอ
    }
});

/* ========== READ (GET) ========== */

// แสดงเส้นทางทั้งหมด (ใหม่สุดก่อน) พร้อมจำนวนออเดอร์   GET /route
router.get("/", async (_req, res) => {
    try {
        const [rows] = await conn.query(
            "SELECT r.id route_id, r.rider_id, ri.name rider_name, r.total_km, r.total_cost, r.created_at, " +
            "COUNT(rs.id) orders_count, GROUP_CONCAT(rs.order_id ORDER BY rs.seq) order_ids " +
            "FROM routes r " +
            "JOIN riders ri ON ri.id = r.rider_id " +
            "LEFT JOIN route_stops rs ON rs.route_id = r.id " +
            "GROUP BY r.id ORDER BY r.created_at DESC"
        );
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database query failed" });
    }
});

// แสดงเส้นทาง 1 เส้นพร้อมจุดส่งทั้งหมด   GET /route/1
router.get("/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ error: "route id ไม่ถูกต้อง" });
        }

        const [routes] = await conn.query(
            "SELECT r.*, ri.name rider_name, ri.phone rider_phone FROM routes r JOIN riders ri ON ri.id = r.rider_id WHERE r.id = ?",
            [id]
        );
        if (!(routes as any[]).length) {
            return res.status(404).json({ error: "ไม่พบเส้นทาง" });
        }

        const [stops] = await conn.query(SELECT_STOPS, [id]);
        res.json({ ...(routes as any[])[0], stops });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database query failed" });
    }
});

// ไรเดอร์ดูงานล่าสุดของตัวเองด้วยรหัสเข้าดูงาน   GET /route/rider-job/:access_code
router.get("/rider-job/:access_code", async (req, res) => {
    try {
        // หาไรเดอร์จาก access_code
        const [riders] = await conn.query(
            "SELECT id,name,phone FROM riders WHERE access_code=?",
            [req.params.access_code]
        );
        const rider = (riders as any[])[0];
        if (!rider) {
            return res.status(404).json({ error: "รหัสเข้าดูงานไม่ถูกต้อง" });
        }

        // เอาเส้นทางล่าสุดของไรเดอร์คนนี้
        const [routes] = await conn.query(
            "SELECT id route_id, total_km, total_cost, created_at FROM routes WHERE rider_id=? ORDER BY created_at DESC LIMIT 1",
            [rider.id]
        );
        if (!(routes as any[]).length) {
            return res.json({ rider, route: null, message: "ยังไม่มีงานที่ได้รับมอบหมาย" });
        }
        const route = (routes as any[])[0];

        const [stops] = await conn.query(SELECT_STOPS, [route.route_id]);
        res.json({ rider, route, stops });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database query failed" });
    }
});

/* ========== UPDATE (PATCH) ========== */

// ไรเดอร์กดส่งของเสร็จ (assigned -> delivered)   PATCH /route/stops/1/delivered
router.patch("/stops/:order_id/delivered", async (req, res) => {
    const id = Number(req.params.order_id);
    if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "order_id ไม่ถูกต้อง" });
    }

    try {
        const [result] = await conn.query(
            "UPDATE orders SET status='delivered' WHERE id=? AND status='assigned'",
            [id]
        );
        if (!(result as any).affectedRows) {
            return res.status(404).json({ error: "ไม่พบออเดอร์ที่กำลัง assigned" });
        }
        res.json({ message: "อัปเดตสถานะส่งสำเร็จ", order_id: id, status: "delivered" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database update failed" });
    }
});