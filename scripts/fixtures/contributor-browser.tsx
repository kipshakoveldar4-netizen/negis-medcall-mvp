import React from "react";
import { createRoot } from "react-dom/client";
import "./contributor-browser-mocks";
import ContributorPortal from "../../artifacts/negis/src/pages/ContributorPortal";
import ControlApp from "../../artifacts/medina-control/src/App";
if (window.location.pathname === "/review") await import("../../artifacts/medina-control/src/styles.css");
else await import("../../artifacts/negis/src/index.css");
createRoot(document.getElementById("root")!).render(window.location.pathname === "/review"
  ? <ControlApp /> : <>
    {new URLSearchParams(window.location.search).get("partner") === "1" && <div role="note" style={{ padding: "10px 16px", background: "#e8f2ff", color: "#17456e", fontSize: 13 }}>Тестовый стенд · вымышленные данные</div>}
    <ContributorPortal />
  </>);
