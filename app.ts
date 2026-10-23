import express from "express";
import { router as index } from "./controller/index";
import { router as customer } from "./controller/customer";
import { router as order } from "./controller/order";
import { router as routes } from "./controller/routes";
import { router as shop } from "./controller/shop";
import cors from "cors";
export const app = express();
// อนุญาตให้หน้าเว็บ (Angular) เรียก API ได้
app.use(cors());
// แปลงข้อมูลรูปแบบ JSON (JSON Body)
app.use(express.json());
app.use("/", index);

app.use("/customer", customer);
app.use("/order", order);
app.use("/shop", shop);
app.use("/routes", routes);
