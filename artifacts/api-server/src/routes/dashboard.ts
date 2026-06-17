import { Router } from "express";

const router = Router();

router.get("/dashboard/metrics", async (req, res) => {
  res.json({
    bookingsToday: 0,
    loadPercent: 0,
    revenueToday: 0,
    visitedToday: 0,
  });
});

export default router;
