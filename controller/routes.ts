import express from "express";
import { conn } from "../dbconnect";

export const router = express.Router();

/* ========== Config (ค่าคงที่ของระบบ) ========== */

const MAX_ORDERS_PER_RIDER = 3;       // ไรเดอร์หนึ่งคนรับได้สูงสุดกี่ออเดอร์
const SPEED_KMH = 30;                 // ความเร็วเฉลี่ยของไรเดอร์ (กม./ชม.) ตามโจทย์
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

// ตัวสุ่มแบบกำหนด seed ได้ (ผลซ้ำได้ถ้า variant เดิม) ใช้สร้างเส้นทางทางเลือก
const seededRandom = (seed: number) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// เลขใบงานของไรเดอร์ ออกใหม่ทุกครั้งที่บันทึกเส้นทาง เช่น 1013-00748 (เดือนวัน-รหัสไรเดอร์ 3 หลัก-เลขสุ่ม 2 หลัก)
// ยาว 10 ตัวอักษรพอดี ตรงกับคอลัมน์ riders.access_code varchar(10) ใช้เวลาไทย
const makeJobCode = (riderId: number) => {
    const d = new Date(Date.now() + 7 * 3600 * 1000);
    const mmdd = String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
    return `${mmdd}-${String(riderId).padStart(3, "0")}${10 + Math.floor(Math.random() * 90)}`;
};

// อ่านโครงสร้างตาราง riders จริง: ใช้สร้างไรเดอร์ใหม่ให้ครบคอลัมน์บังคับ และตัดเลขใบงานให้พอดีความยาวคอลัมน์
type Col = { Field: string; Type: string; Null: string; Default: any; Extra: string };
const colMaxLen = (c?: Col) => {
    const m = c ? /char\((\d+)\)/i.exec(c.Type) : null;
    return m ? Number(m[1]) : Infinity;
};
const fit = (text: string, len: number) => (text.length <= len ? text : text.slice(-len));

async function insertRider(cx: any, cols: Col[], name: string) {
    const by = new Map(cols.map(c => [c.Field, c]));
    const row: Record<string, any> = {};
    if (by.has("name")) row.name = name.slice(0, colMaxLen(by.get("name")));
    if (by.has("phone")) row.phone = "-".slice(0, colMaxLen(by.get("phone")));
    if (by.has("access_code")) {
        const tmp = Math.random().toString(36).slice(2, 10).toUpperCase(); // ชั่วคราว จะถูกแทนด้วยเลขใบงานทันที
        row.access_code = fit(tmp, colMaxLen(by.get("access_code")));
    }
    // คอลัมน์บังคับอื่นๆ ที่ไม่มีค่าเริ่มต้น -> เติมค่าว่าง/0
    for (const c of cols) {
        if (c.Field in row || c.Null === "YES" || c.Default !== null || /auto_increment|generated/i.test(c.Extra)) continue;
        row[c.Field] = /int|decimal|float|double/i.test(c.Type) ? 0 : /date|time/i.test(c.Type) ? new Date() : "";
    }
    const keys = Object.keys(row);
    const [ins] = await cx.query(
        `INSERT INTO riders(${keys.map(k => "`" + k + "`").join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
        keys.map(k => row[k])
    );
    return (ins as any).insertId as number;
}

/* ========== Optimizer (แบ่งออเดอร์ให้ไรเดอร์) ========== */

const MAX_RIDERS = 100;           // ร้านเรียกไรเดอร์เพิ่มได้ (เพดานต่อรอบ)
const DEADLINE_MINUTES = 60;      // ออกส่ง 11:30 ต้องถึงลูกค้าไม่เกิน 12:30
const LATE_PENALTY_PER_MIN = 50;  // โทษถ้าส่งช้า (บาท/นาที) เพื่อให้ตัวคำนวณเลี่ยงแผนที่ส่งไม่ทัน

// ตัวสุ่มที่กำหนด seed ได้ -> "ทางเลือกที่ N" ได้ผลเดิมทุกครั้ง
function makeRng(seed: number) {
    let a = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// เวลาที่ไรเดอร์ถึงลูกค้าคนสุดท้าย (นาที นับจาก 11:30) = เวลาขับ + เวลาส่งของจุดก่อนหน้า
const arrivalMinutes = (kmToLast: number, stops: number) =>
    (kmToLast / SPEED_KMH) * 60 + Math.max(0, stops - 1) * SERVICE_MINUTES_PER_STOP;

// "คะแนน" ของไรเดอร์ 1 คน = ค่าตอบแทนไรเดอร์ + โทษส่งช้า (ยิ่งต่ำยิ่งดี)
function tripScore(orders: any[], shop: Point) {
    if (!orders.length) return 0;
    const opt = findBestStopOrder(orders.map(toPoint), shop);
    const boxes = orders.reduce((s, o) => s + Number(o.boxes), 0);
    const late = Math.max(0, arrivalMinutes(opt.km, orders.length) - DEADLINE_MINUTES);
    return calcRiderCost(opt.km, boxes) + late * LATE_PENALTY_PER_MIN;
}

// แบ่ง orders เป็นกลุ่ม (ไรเดอร์ละกลุ่ม ไม่เกิน 3) ให้ต้นทุนรวมต่ำสุด:
// เริ่มจากแบ่งตามทิศ (สุ่มจุดเริ่ม) แล้วปรับปรุงด้วยการย้าย/สลับออเดอร์จนไม่ดีขึ้นอีก
function optimizeGroups(orders: any[], riderSlots: number, shop: Point, rng: () => number, cache: Map<string, number>) {
    const score = (g: any[]) => {
        if (!g.length) return 0;
        const key = g.map(o => o.id).sort((x, y) => x - y).join(",");
        let v = cache.get(key);
        if (v === undefined) {
            v = tripScore(g, shop);
            cache.set(key, v);
        }
        return v;
    };

    const slots = Math.min(riderSlots, orders.length);
    const bearingOf = (o: any) => {
        const p = toPoint(o);
        return Math.atan2(p.lng - shop.lng, p.lat - shop.lat);
    };
    const offset = rng() * 2 * Math.PI;
    const keyed = orders
        .map(o => ({ o, k: (((bearingOf(o) - offset) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) + (rng() - 0.5) * 0.5 }))
        .sort((x, y) => x.k - y.k)
        .map(x => x.o);

    const groups: any[][] = Array.from({ length: slots }, () => []);
    keyed.forEach((o, i) => groups[Math.floor(i / MAX_ORDERS_PER_RIDER)].push(o));

    const shuffle = <T,>(arr: T[]) => {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    };

    for (let pass = 0; pass < 40; pass++) {
        let changed = false;

        // ย้ายออเดอร์ไปกลุ่มอื่น (รวมกลุ่มว่าง 1 กลุ่ม) ถ้าต้นทุนรวมลดลง
        for (const o of shuffle([...orders])) {
            const a = groups.findIndex(g => g.includes(o));
            const without = groups[a].filter(x => x !== o);
            let bestB = -1;
            let bestDelta = -1e-9;
            let triedEmpty = false;
            for (let b = 0; b < groups.length; b++) {
                if (b === a || groups[b].length >= MAX_ORDERS_PER_RIDER) continue;
                if (!groups[b].length) {
                    if (triedEmpty) continue;
                    triedEmpty = true;
                }
                const delta = score(without) + score([...groups[b], o]) - score(groups[a]) - score(groups[b]);
                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestB = b;
                }
            }
            if (bestB >= 0) {
                groups[bestB] = [...groups[bestB], o];
                groups[a] = without;
                changed = true;
            }
        }

        // สลับออเดอร์ระหว่าง 2 กลุ่ม ถ้าต้นทุนรวมลดลง
        for (const x of shuffle([...orders])) {
            for (const y of shuffle([...orders])) {
                const a = groups.findIndex(g => g.includes(x));
                const b = groups.findIndex(g => g.includes(y));
                if (a === b) continue;
                const na = [...groups[a].filter(o => o !== x), y];
                const nb = [...groups[b].filter(o => o !== y), x];
                if (score(na) + score(nb) < score(groups[a]) + score(groups[b]) - 1e-9) {
                    groups[a] = na;
                    groups[b] = nb;
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }

    const used = groups.filter(g => g.length);
    return { groups: used, total: used.reduce((s, g) => s + score(g), 0) };
}

/* ========== CALCULATE (คำนวณเส้นทาง ยังไม่บันทึก) ========== */

// พรีวิวการจัดเส้นทาง (ใช้เฉพาะออเดอร์ pending)   POST /routes/calculate
// body (ไม่บังคับ): { variant: 0, tries: 1 }
//   variant = หมายเลขทางเลือก (เปลี่ยนเลขเพื่อให้ได้แผนอื่น)
//   tries   = ลองกี่แผนแล้วเลือกต้นทุนต่ำสุด (ใช้ตอน "หาแผนที่ดีที่สุด" เช่น 40)
router.post("/calculate", async (req, res) => {
    try {
        const variant = Math.max(0, Math.floor(Number(req.body?.variant) || 0));
        const tries = Math.min(60, Math.max(1, Math.floor(Number(req.body?.tries) || 1)));

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
        const [riders] = await conn.query("SELECT id,name,phone,access_code FROM riders ORDER BY id");
        const pending = orders as any[];
        const realRiders = riders as any[];
        // ไรเดอร์ในระบบไม่พอ -> เรียกเพิ่มอัตโนมัติ (rider_id ติดลบ = ยังไม่มีในฐานข้อมูล จะสร้างตอนกด "บันทึก")
        const available = [...realRiders];
        while (available.length < Math.min(pending.length, MAX_RIDERS)) {
            const k = available.length - realRiders.length + 1;
            available.push({ id: -k, name: `ไรเดอร์ใหม่ ${k}`, phone: "", access_code: null, is_new: true });
        }

        const emptySummary = {
            orders: 0, orders_assigned: 0, orders_unassigned: 0, riders_used: 0,
            total_km: 0, total_rider_cost: 0, revenue: 0, food_cost: 0,
            profit_before_other_expenses: 0, within_one_hour: true,
        };
        // ไม่มีออเดอร์ให้จัด -> ตอบผลว่างพร้อมสรุปเป็น 0
        if (!pending.length) {
            return res.json({
                message: "ไม่มีออเดอร์ pending สำหรับจัดเส้นทาง",
                shop, routes: [], unassigned: [], summary: emptySummary, variant, tries,
            });
        }
        if (!available.length) {
            return res.status(400).json({ error: "ยังไม่มีไรเดอร์ในระบบ" });
        }

        // ไรเดอร์รับได้คนละไม่เกิน 3 ออเดอร์ -> ถ้าไรเดอร์ไม่พอ ส่งออเดอร์ที่ใกล้ร้านก่อน ที่เหลือเป็น unassigned
        const byDistance = [...pending].sort((a, b) => distanceKm(shopPoint, toPoint(a)) - distanceKm(shopPoint, toPoint(b)));
        const capacity = available.length * MAX_ORDERS_PER_RIDER;
        const toPlan = byDistance.slice(0, capacity);
        const leftover = byDistance.slice(capacity);

        // ลองหลายแผน (seed ต่างกัน) แล้วเลือกแผนที่ต้นทุนรวมต่ำสุด
        const cache = new Map<string, number>();
        let best: { groups: any[][]; total: number } | null = null;
        let bestVariant = variant;
        for (let t = 0; t < tries; t++) {
            const r = optimizeGroups(toPlan, available.length, shopPoint, makeRng(variant + t), cache);
            if (!best || r.total < best.total - 1e-9) {
                best = r;
                bestVariant = variant + t;
            }
        }

        // เรียงกลุ่มตามทิศจากร้าน แล้วให้ไรเดอร์คนที่ 1, 2, 3 ... ตามลำดับ (สีเส้นทางจะคงที่)
        const dir = (g: any[]) => {
            const p = toPoint(g[0]);
            const a = Math.atan2(p.lng - shopPoint.lng, p.lat - shopPoint.lat);
            return (a + 2 * Math.PI) % (2 * Math.PI);
        };
        const plans = best!.groups
            .sort((a, b) => dir(a) - dir(b))
            .map((g, i) => ({ rider: available[i], orders: g, stops: [] as any[] }));

        // หาลำดับส่งที่ดีที่สุดของแต่ละคน แล้วคำนวณต้นทุน เวลา และกำไร
        const routes = plans.map(p => {
            const opt = findBestStopOrder(p.orders.map(toPoint), shopPoint);

            let previous: Point = shopPoint;
            let travelKm = 0;
            p.stops = opt.order.map((idx, i) => {
                const o = p.orders[idx];
                const point = toPoint(o);
                const leg = distanceKm(previous, point);
                travelKm += leg;
                previous = point;
                const arrive = arrivalMinutes(travelKm, i + 1);
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
                    arrive_minutes: Number(arrive.toFixed(1)),
                    arrive_time: formatArrival(arrive),
                };
            });

            const km = opt.km;
            const boxes = p.orders.reduce((s, o) => s + Number(o.boxes), 0);
            const riderCost = calcRiderCost(km, boxes);
            const revenue = boxes * PRICE_PER_BOX;
            const foodCost = boxes * FOOD_COST_PER_BOX;
            const minutes = arrivalMinutes(km, p.orders.length); // ถึงลูกค้าคนสุดท้าย

            return {
                rider_id: p.rider.id,
                rider_name: p.rider.name,
                rider_phone: p.rider.phone,
                is_new: !!p.rider.is_new,
                access_code: p.rider.access_code,
                orders_count: p.orders.length,
                total_boxes: boxes,
                total_km: Number(km.toFixed(2)),
                estimated_minutes: Number(minutes.toFixed(1)),
                estimated_arrival: formatArrival(minutes),
                on_time: minutes <= DEADLINE_MINUTES,
                rider_cost: Number(riderCost.toFixed(2)),
                revenue,
                food_cost: foodCost,
                profit_before_other_expenses: Number((revenue - foodCost - riderCost).toFixed(2)),
                stops: p.stops,
            };
        });

        const sum = (key: string) => routes.reduce((s: any, r: any) => s + Number(r[key] || 0), 0);
        const needMore = Math.max(0, Math.ceil(pending.length / MAX_ORDERS_PER_RIDER) - available.length);

        res.json({
            method: "แบ่งกลุ่มตามทิศ + ย้าย/สลับออเดอร์ให้ต้นทุนรวมต่ำสุด + เรียงจุดส่งแบบลองทุกลำดับ (ระยะเป็นเส้นตรง ไม่ใช่ถนนจริง)",
            shop,
            variant: bestVariant,
            tries,
            settings: {
                max_orders_per_rider: MAX_ORDERS_PER_RIDER,
                estimated_speed_kmh: SPEED_KMH,
                service_minutes_per_stop: SERVICE_MINUTES_PER_STOP,
                price_per_box: PRICE_PER_BOX,
                food_cost_per_box: FOOD_COST_PER_BOX,
                trip_fee: TRIP_FEE,
                rider_rate_per_box_km: RIDER_RATE_PER_BOX_KM,
                delivery_window: "11:30–12:30",
            },
            routes,
            unassigned: leftover.map(o => ({
                order_id: o.id,
                reason: `ไรเดอร์ไม่พอ (ไรเดอร์ละไม่เกิน ${MAX_ORDERS_PER_RIDER} ออเดอร์) ต้องเพิ่มไรเดอร์อีก ${needMore} คน`,
            })),
            summary: {
                orders: pending.length,
                orders_assigned: routes.reduce((s, r) => s + r.orders_count, 0),
                orders_unassigned: leftover.length,
                riders_used: routes.length,
                total_km: Number(sum("total_km").toFixed(2)),
                total_rider_cost: Number(sum("rider_cost").toFixed(2)),
                revenue: sum("revenue"),
                food_cost: sum("food_cost"),
                profit_before_other_expenses: Number(sum("profit_before_other_expenses").toFixed(2)),
                within_one_hour: routes.every(r => r.on_time),
                latest_arrival_minutes: Number(Math.max(...routes.map(r => r.estimated_minutes)).toFixed(1)),
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

        // ตรวจว่า rider_id ที่ระบุ (> 0) มีอยู่จริง
        const existingIds = [...new Set(assignments.map((a: any) => Number(a.rider_id)).filter((n: number) => n > 0))];
        if (existingIds.length) {
            const [riderRows] = await cx.query(
                `SELECT id FROM riders WHERE id IN (${existingIds.map(() => "?").join(",")})`,
                existingIds
            );
            if ((riderRows as any[]).length !== existingIds.length) {
                await cx.rollback();
                return res.status(400).json({ error: "พบ rider_id ที่ไม่มีในระบบ" });
            }
        }

        // rider_id ติดลบ = ไรเดอร์ใหม่ที่ระบบเรียกเพิ่ม -> สร้างแถวในตาราง riders
        const [colRows] = await cx.query("SHOW COLUMNS FROM riders");
        const riderCols = colRows as Col[];
        const codeLen = colMaxLen(riderCols.find(c => c.Field === "access_code"));
        const realId = new Map<number, number>();
        for (const a of assignments) {
            const rid = Number(a.rider_id);
            if (rid < 0 && !realId.has(rid)) {
                const name = String(a.rider_name || `ไรเดอร์ใหม่ ${-rid}`);
                realId.set(rid, await insertRider(cx, riderCols, name));
            }
        }
        const riderIdOf = (a: any) => (Number(a.rider_id) < 0 ? (realId.get(Number(a.rider_id)) as number) : Number(a.rider_id));

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
                [riderIdOf(a), Number(opt.km.toFixed(2)), Number(cost.toFixed(2))]
            );
            const routeId = (routeResult as any).insertId;

            // ออกเลขใบงานใหม่ให้ไรเดอร์คนนี้ (ไรเดอร์ใช้เลขนี้เข้าดูใบงานของวันนั้น)
            const jobCode = fit(makeJobCode(riderIdOf(a)), codeLen);
            await cx.query("UPDATE riders SET access_code=? WHERE id=?", [jobCode, riderIdOf(a)]);

            for (let i = 0; i < ordered.length; i++) {
                await cx.query(
                    "INSERT INTO route_stops(route_id,order_id,seq) VALUES(?,?,?)",
                    [routeId, ordered[i].id, i + 1]
                );
                await cx.query("UPDATE orders SET status='assigned' WHERE id=?", [ordered[i].id]);
            }

            output.push({
                route_id: routeId,
                rider_id: riderIdOf(a),
                job_code: jobCode,
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
            "SELECT r.id route_id, r.rider_id, ri.name rider_name, ri.access_code rider_access_code, r.total_km, r.total_cost, r.created_at, " +
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
            "SELECT r.*, ri.name rider_name, ri.phone rider_phone, ri.access_code rider_access_code FROM routes r JOIN riders ri ON ri.id = r.rider_id WHERE r.id = ?",
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

/* ========== DELETE ========== */

// ลบเส้นทางทั้งหมด (ออเดอร์ที่ยังไม่ส่งจะกลับเป็น pending)   DELETE /routes
// ต้องวางก่อน "/:id" เพื่อไม่ให้ชื่อชนกัน
router.delete("/", async (_req, res) => {
    const cx = await conn.getConnection();
    try {
        await cx.beginTransaction();
        await cx.query(
            "UPDATE orders SET status='pending' WHERE status='assigned' AND id IN (SELECT order_id FROM route_stops)"
        );
        await cx.query("DELETE FROM route_stops");
        const [result] = await cx.query("DELETE FROM routes");
        await cx.commit();
        res.json({ message: "ลบเส้นทางทั้งหมดแล้ว", affected_row: (result as any).affectedRows });
    } catch (e) {
        await cx.rollback();
        console.error(e);
        res.status(500).json({ error: "ลบเส้นทางไม่สำเร็จ" });
    } finally {
        cx.release();
    }
});

// ลบเส้นทาง 1 เส้น (ออเดอร์ที่ยังไม่ส่งในเส้นทางนั้นจะกลับเป็น pending ให้จัดใหม่ได้)   DELETE /routes/1
router.delete("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "id ต้องเป็นจำนวนเต็มบวก" });
    }
    const cx = await conn.getConnection();
    try {
        await cx.beginTransaction();
        const [found] = await cx.query("SELECT id FROM routes WHERE id=? FOR UPDATE", [id]);
        if (!(found as any[]).length) {
            await cx.rollback();
            return res.status(404).json({ error: "ไม่พบเส้นทาง" });
        }
        await cx.query(
            "UPDATE orders SET status='pending' WHERE status='assigned' AND id IN (SELECT order_id FROM route_stops WHERE route_id=?)",
            [id]
        );
        await cx.query("DELETE FROM route_stops WHERE route_id=?", [id]);
        await cx.query("DELETE FROM routes WHERE id=?", [id]);
        await cx.commit();
        res.json({ message: "ลบเส้นทางแล้ว", id });
    } catch (e) {
        await cx.rollback();
        console.error(e);
        res.status(500).json({ error: "ลบเส้นทางไม่สำเร็จ" });
    } finally {
        cx.release();
    }
});