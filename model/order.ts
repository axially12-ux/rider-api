export interface Order {
    id: number;
    customer_id: number;
    boxes: number; // 1-3 กล่อง
    status: string;
    created_at: string;
}

