import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import App from "../../artifacts/medina-control/src/App";
import { subscriptionAuthFixture, subscriptionFixtureControl } from "./control-subscription-browser-mocks";

function Fixture() {
  const auth = useSyncExternalStore(subscriptionAuthFixture.subscribe, subscriptionAuthFixture.snapshot);
  const [server, setServer] = useState<Awaited<ReturnType<typeof subscriptionFixtureControl>> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const action = useRef(false);
  const mounted = useRef(false);
  const requestVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      if (!mounted.current || action.current) return;
      const version = ++requestVersion.current;
      const current = () => mounted.current && version === requestVersion.current;
      void subscriptionFixtureControl().then((state) => { if (current()) { setServer(state); setError(""); } })
        .catch(() => { if (current()) setError("Fixture state unavailable"); });
    };
    refresh();
    addEventListener("qa-control-subscription-http", refresh);
    return () => {
      mounted.current = false; requestVersion.current++; action.current = false;
      removeEventListener("qa-control-subscription-http", refresh);
    };
  }, []);
  async function control(command?: Record<string, unknown>, after?: () => void) {
    if (!mounted.current || action.current) return;
    const version = ++requestVersion.current;
    const current = () => mounted.current && version === requestVersion.current;
    action.current = true; setBusy(true); setError("");
    try {
      const state = await subscriptionFixtureControl(command);
      if (current()) { setServer(state); after?.(); }
    }
    catch { if (current()) setError("Fixture control failed"); }
    finally { if (current()) { action.current = false; setBusy(false); } }
  }
  return <>
    <style>{`
      .qa-subscription-controls { padding: 10px 16px; background: #fff7dc; border-bottom: 1px solid #d3b75d; color: #242820; }
      .qa-subscription-controls strong { font-size: 14px; }
      .qa-subscription-controls .qa-note { margin-left: 12px; font-size: 12px; }
      .qa-subscription-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: 8px; }
      .qa-subscription-actions fieldset { display: flex; flex-wrap: wrap; gap: 10px; margin: 0; padding: 4px 10px; border: 1px solid #b1a46d; border-radius: 4px; }
      .qa-subscription-actions legend { padding: 0 4px; font-size: 12px; }
      .qa-subscription-actions label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
      .qa-subscription-controls button { padding: 6px 10px; border: 1px solid #b1a46d; border-radius: 4px; background: #fff; color: inherit; font-size: 12px; }
      .qa-subscription-controls output { display: block; margin-top: 6px; font-size: 12px; overflow-wrap: anywhere; }
      .qa-subscription-controls p[role=alert] { margin: 4px 0 0; color: #b4232a; }
      @media(max-width: 620px) { .qa-subscription-controls { padding: 8px 12px; } .qa-subscription-controls .qa-note { display: block; margin-left: 0; } }
    `}</style>
    <header className="qa-subscription-controls" data-testid="control-subscription-fixture">
      <strong>QA subscription</strong><span className="qa-note">Synthetic data; loopback HTTP; in-memory only, not SQL or real Auth. Owner A; B denied on onboarding/operators.</span>
      <div className="qa-subscription-actions">
        <fieldset><legend>Synthetic actor</legend>
          {(["A", "B"] as const).map((actor) => <label key={actor}>
            <input type="radio" name="qa-actor" value={actor} checked={auth.actor === actor}
              onChange={() => subscriptionAuthFixture.select(actor)} />Actor {actor}
          </label>)}
        </fieldset>
        <button type="button" onClick={subscriptionAuthFixture.aba}>A - B - A</button>
        <button type="button" onClick={subscriptionAuthFixture.silentB}>Silent SDK B</button>
        <button type="button" onClick={subscriptionAuthFixture.refresh}>Refresh token</button>
        <label><input type="checkbox" checked={server?.failAfterCommit ?? false} disabled={busy || !server}
          onChange={(event) => void control({ command: "failAfterCommit", enabled: event.target.checked })} />Fail one response after commit</label>
        <label><input type="checkbox" checked={server?.holdOwnerReply ?? false} disabled={busy || !server || server.ownerReplyPending}
          onChange={(event) => void control({ command: "holdOwnerReply", enabled: event.target.checked })} />Hold next owner mutation reply</label>
        <button type="button" disabled={busy} onClick={() => void control()}>Read counters</button>
        <button type="button" disabled={busy || !server?.ownerReplyPending}
          onClick={() => void control({ command: "releaseOwnerReply" })}>Release owner reply</button>
        <button type="button" disabled={busy} onClick={() => void control({ command: "reset" }, subscriptionAuthFixture.reset)}>Reset fixture</button>
      </div>
      <output data-testid="control-subscription-state" aria-live="polite">
        Actor {auth.actor || "signed out"}; failure {server?.failAfterCommit ? "armed" : "off"}; commits {server?.counters.commits ?? 0};
        {" "}replays {server?.counters.replays ?? 0}; abandoned {server?.counters.abandons ?? 0}; failed responses {server?.counters.lostResponses ?? 0}
      </output>
      <output data-testid="control-owner-state" aria-live="polite">
        Owner mutations {server?.ownerCounters.mutations ?? 0}; operators {server?.ownerCounters.operatorChanges ?? 0};
        {" "}credentials {server?.ownerCounters.credentials ?? 0}; invites {server?.ownerCounters.onboardingInvites ?? 0};
        {" "}reissues {server?.ownerCounters.reissues ?? 0}; denied {server?.ownerCounters.denied ?? 0}; reply {server?.ownerReplyPending ? "held" : "not held"}
        {server?.heldOwnerReply ? ` (${server.heldOwnerReply.method} ${server.heldOwnerReply.path})` : ""}
      </output>
      {error ? <p role="alert">{error}</p> : null}
    </header>
    <App />
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
