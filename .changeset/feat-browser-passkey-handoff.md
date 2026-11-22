---
"turno-browser": minor
---

A page's passkey prompt hands the browser to the person by itself. When a page starts a WebAuthn ceremony that puts up Chrome's passkey window (creating a passkey, or signing in with one), the agent's calls wait while a banner asks the person to use their passkey there, and the step ends when the request settles, on Done or after 5 minutes. The call that started it (or the next one) says how it went: created, used, cancelled or timed out, or failed with the error's name, never credential data (`turno.passkey` in JSON). Passkey autofill (`mediation: "conditional"`) never stops the agent. A headless Chrome cannot show that window, not even in the live view, so the agent is told to ask the person for a browser with a window instead of waiting. In attach mode only the agent's own tabs count.
