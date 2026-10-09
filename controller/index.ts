import express from "express";
import { conn } from "../dbconnect";
export const router = express.Router();
router.get("/", (_req, res) => res.json({ message: "Rider API is running" }));
router.get("/health", async (_req, res) => { try {
    await conn.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
}
catch (e) {
    console.error(e);
    res.status(503).json({ status: "error", database: "unavailable" });
} });

