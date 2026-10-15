/**
 * กติกาเดียวกันทั้งระบบว่า "ลูกค้าซ้ำ" คืออะไร
 * - ชื่อซ้ำ   = ชื่อ + นามสกุลเหมือนกัน (ตัดช่องว่างหัวท้าย ยุบช่องว่างซ้อน ไม่สนตัวพิมพ์เล็ก/ใหญ่)
 * - พิกัดซ้ำ  = lat/lng เท่ากันเมื่อปัดเป็นทศนิยม 6 ตำแหน่ง (~0.1 เมตร)
 *   ใช้ความละเอียดเดียวกับ service/road.ts (pk) เพราะจุดที่พิกัดเท่ากันจะถูกรวมเป็นจุดเดียวตอนคำนวณระยะทาง
 */

export type CustomerLike = {
    id: number;
    first_name: string;
    last_name: string;
    lat: number | string;
    lng: number | string;
};

// ทำความสะอาดชื่อก่อนบันทึก/เทียบ: ตัดช่องว่างหัวท้าย และยุบช่องว่างซ้อนกันให้เหลือช่องเดียว
export const cleanName = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ");

export const nameKey = (c: Pick<CustomerLike, "first_name" | "last_name">) =>
    `${cleanName(c.first_name).toLowerCase()}|${cleanName(c.last_name).toLowerCase()}`;

export const coordKey = (c: Pick<CustomerLike, "lat" | "lng">) =>
    `${Number(c.lat).toFixed(6)},${Number(c.lng).toFixed(6)}`;

/**
 * เลือกลูกค้าที่ "ชื่อไม่ซ้ำและพิกัดไม่ซ้ำ" จากรายการ
 * - เรียงตามลำดับที่ส่งเข้ามา ถ้าซ้ำจะเก็บคนแรก (ส่งเรียงตาม id จึงเก็บ id น้อยสุด)
 * - blocked = ลูกค้าที่ถือว่า "ใช้ไปแล้ว" (เช่น มีออเดอร์ค้างอยู่) ชื่อ/พิกัดของคนเหล่านี้จะถูกกันไม่ให้ใครซ้ำด้วย
 */
export function pickDistinctCustomers<T extends CustomerLike>(
    rows: T[],
    blocked: T[] = []
): { picked: T[]; skipped: T[] } {
    const seenNames = new Set<string>(blocked.map(nameKey));
    const seenCoords = new Set<string>(blocked.map(coordKey));
    const picked: T[] = [];
    const skipped: T[] = [];

    for (const c of rows) {
        const n = nameKey(c);
        const p = coordKey(c);
        if (seenNames.has(n) || seenCoords.has(p)) {
            skipped.push(c);
            continue;
        }
        seenNames.add(n);
        seenCoords.add(p);
        picked.push(c);
    }
    return { picked, skipped };
}