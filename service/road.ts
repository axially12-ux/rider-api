import "dotenv/config";
/**
 * ระยะทางตามถนนจริง (กม.) จาก OSRM (Table API)
 * - ขอครั้งเดียวต่อรอบคำนวณ ได้ระยะระหว่างทุกคู่จุด แล้วเก็บแคชไว้ในหน่วยความจำ
 * - ถ้า OSRM ใช้ไม่ได้ ใช้ระยะเส้นตรง x ROAD_DETOUR_FACTOR แทน (ประมาณการ) และบอกใน source = "estimate"
 */

export type Point = { lat: number; lng: number };
export type DistFn = (a: Point, b: Point) => number;

const OSRM_URL = (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
const ROAD_DETOUR_FACTOR = 1.3;  // ถนนจริงยาวกว่าเส้นตรงโดยเฉลี่ยราว 30%
const MAX_TABLE_POINTS = 90;     // เซิร์ฟเวอร์สาธารณะจำกัดจำนวนจุดต่อคำขอ
const TIMEOUT_MS = 8000;
const RETRY_AFTER_MS = 60_000;  // OSRM ล่ม/ช้า: พักไม่ขอซ้ำ 1 นาที ไม่ให้ทุกคำขอต้องรอ timeout
let downUntil = 0;

export const haversineKm = (a: Point, b: Point) => {
    const rad = (n: number) => (n * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
};

const pk = (p: Point) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
const cache = new Map<string, number>(); // "จุดA|จุดB" -> กม. (มีทิศทาง เผื่อถนนเดินรถทางเดียว)

export async function buildDistance(points: Point[]): Promise<{ dist: DistFn; source: "road" | "estimate" }> {
    const unique = [...new Map(points.map(p => [pk(p), p])).values()];

    const missing = () => {
        for (const a of unique) for (const b of unique) {
            if (a !== b && !cache.has(pk(a) + "|" + pk(b))) return true;
        }
        return false;
    };

    if (unique.length > 1 && missing() && unique.length <= MAX_TABLE_POINTS && Date.now() >= downUntil) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const coords = unique.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
            const res = await fetch(`${OSRM_URL}/table/v1/driving/${coords}?annotations=distance`, { signal: ctrl.signal });
            if (!res.ok) downUntil = Date.now() + RETRY_AFTER_MS;
            else {
                const j: any = await res.json();
                if (j.code !== "Ok") downUntil = Date.now() + RETRY_AFTER_MS;
                if (j.code === "Ok" && Array.isArray(j.distances)) {
                    if (cache.size > 50000) cache.clear();
                    unique.forEach((a, i) => unique.forEach((b, k) => {
                        const m = j.distances[i]?.[k];
                        if (i !== k && typeof m === "number") cache.set(pk(a) + "|" + pk(b), m / 1000);
                    }));
                }
            }
        } catch (e) {
            downUntil = Date.now() + RETRY_AFTER_MS;
            console.warn("ขอระยะทางถนนจริงจาก OSRM ไม่สำเร็จ ใช้ระยะประมาณแทน:", e instanceof Error ? e.message : e);
        } finally {
            clearTimeout(timer);
        }
    }

    const source = unique.length <= 1 || !missing() ? "road" : "estimate";
    const dist: DistFn = (a, b) => {
        if (pk(a) === pk(b)) return 0;
        return cache.get(pk(a) + "|" + pk(b)) ?? haversineKm(a, b) * ROAD_DETOUR_FACTOR;
    };
    return { dist, source };
}
