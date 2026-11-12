const ids = {
  request: "00000000-0000-4000-8000-000000000801",
  lead: "00000000-0000-4000-8000-000000000802",
  doctor: "00000000-0000-4000-8000-000000000803",
  service: "00000000-0000-4000-8000-000000000804",
};

// Visual-only state. No Auth, environment, database or external request is used.
export function createOperatorBrowserFixture() {
  let suspended = false;
  let ended = false;
  const ok = (data: unknown) => Response.json({ success: true, data });
  const deny = () => Response.json({ success: false }, { status: 403 });
  return {
    suspend() { suspended = true; },
    endCooperation() { ended = true; },
    request(url: URL, init?: RequestInit): Response {
      init?.signal?.throwIfAborted();
      if (url.origin !== "http://fixture.invalid" || !url.pathname.startsWith("/api/crm/operator-")) {
        throw new Error("Only isolated operator fixture routes are permitted");
      }
      if (init?.method && init.method !== "GET") return deny();
      const resource = url.pathname.split("/").at(-1);
      if (resource === "operator-account") return ok({
        id: "fixture-operator", displayName: "ТЕСТ O1 оператор", status: suspended ? "suspended" : "approved",
        acceptingRequests: false,
      });
      if (suspended) return deny();
      if (resource === "operator-inbox") return ok({ items: [{
        id: ids.request, displayName: "ТЕСТ O1 пространство", status: ended ? "ended" : "accepted", leadScope: "assigned",
        clinicBrief: "Только синтетические данные", currency: "KZT", pricePerArrivalMinor: "0",
      }], hasMore: false });
      if (ended) return deny();
      if (url.searchParams.get("requestId") !== ids.request) return deny();
      if (resource === "operator-leads") return ok({ items: [{
        id: ids.lead, name: "ТЕСТ O1 контакт", phone: "+70000000991", status: "new", stageId: null,
        stageName: "Новая", source: "fixture", createdAt: "2026-10-17T09:00:00Z",
      }], hasMore: false, stages: [], stageEditingAvailable: true });
      if (resource === "operator-bookings") return url.searchParams.get("leadId") === ids.lead
        ? ok({ timeZone: "UTC" }) : deny();
      if (resource === "operator-arrivals") return ok({ items: [], hasMore: false });
      if (resource === "operator-services") {
        const doctor = url.searchParams.get("doctorId");
        if (doctor && doctor !== ids.doctor) return deny();
        return ok({ items: doctor ? [{ id: ids.service, name: "ТЕСТ O1 услуга", priceMinor: "0", durationMinutes: 60, currency: "KZT" }]
          : [{ id: ids.doctor, name: "ТЕСТ O1 специалист", specialty: "fixture" }], hasMore: false });
      }
      return deny();
    },
  };
}
