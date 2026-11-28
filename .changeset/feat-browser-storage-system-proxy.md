---
"turno-browser": minor
"turno-cli": patch
---

The `storage` tools (cookies, localStorage, sessionStorage and the storage state file) are listed by default, with session values masked: a cookie that is HttpOnly, named like a credential (`session`, `sid`, `token`, `auth`, `csrf`, `login`) or holding a random-looking value, and the tokens in stored items, read `[masked]`. Names, domains, paths, expiry and flags stay. After every browser call the server reads the cookies and the page's web storage, so a random-looking session value is also hidden from `browser_evaluate` (`document.cookie`), response bodies, console messages, snapshots and written files. A mask written back keeps the value it stands for, in the same cookie or item only, so `browser_cookie_set` with `[masked]` and `browser_set_storage_state` with a saved file keep the session. Attach mode and a policy that lists `storage` keep the tools off.

Without a proxy of its own, an identity's Chrome follows the system's proxy as before; `show` and `status` now name it (macOS `scutil --proxy`, Windows Internet Settings, GNOME settings or the proxy variables), and `"proxy": false` makes Chrome connect directly. With a proxy in use, turno-browser looks up where it exits (one HTTPS request to get.geojs.io through the proxy, once a day per proxy) and warns when the identity's time zone or locale does not match; `TURNO_BROWSER_EXIT_CHECK=0` turns the lookup off.
