# Logout Completion Ownership

G7-C35, 26 October 2026, base 59ab246. Local only.

An unmounted AuthProvider could clear a newer provider's pending-signout
marker when its earlier SDK request completed. Shared-storage regression
reproduced this before the fix. Each request now captures the existing
signout revision and checks ownership before SDK dispatch and after completion;
obsolete successes and failures cannot unlock or publish into the new exit.

Actual provider VM plus boundary suites: 117/117. Fixed no-network runner:
931/931, no skips, unchanged 41-reader/network/IPC boundaries. The reviewed
AuthContext reader hash alone was updated. Full build passes both API modes,
types, 143 cold starts and Vite (g71-build.log). No React DOM/browser or real
SDK/server-session-revocation acceptance is claimed by these VM tests.

No deployments, migrations, account changes, providers, expenses, Production,
Baspana, salon or WhatsApp actions. The next priority is contributor onboarding:
operators plus bloggers who can independently request partner and creator roles.
