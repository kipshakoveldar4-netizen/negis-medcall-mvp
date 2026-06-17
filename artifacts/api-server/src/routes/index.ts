import { Router } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import employeesRouter from "./employees";
import webhookRouter from "./webhook";
import impersonationRouter from "./impersonation";
import testAuthRouter from "./test-auth";
import adsTikTokRouter from "./ads-tiktok";
import authResetRouter from "./auth-reset";
import authRegisterRouter from "./auth-register";

const router = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(employeesRouter);
router.use(webhookRouter);
router.use(impersonationRouter);
router.use(testAuthRouter);
router.use(adsTikTokRouter);
router.use(authResetRouter);
router.use(authRegisterRouter);

export default router;
