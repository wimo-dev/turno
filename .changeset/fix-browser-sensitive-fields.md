---
"turno-browser": patch
---

A password or one-time code never reaches the agent, whoever typed it: every page snapshot (also the snapshot files an action writes to the workspace) shows its value as `[sensitive field]`, and the value is hidden from every later result. `browser_type`, `browser_fill_form` and key presses into a password or one-time code field are refused with an error that says to ask the person (`browser_request_human`) or to use `browser_login`; a flow replay types one only from the secret store (`keychain:<item>`). `browser_network_requests` and `browser_network_request` keep the names of credentials and show `[redacted]` for their values (Authorization, Cookie and Set-Cookie headers, token, code, session, key, secret and password fields), also in a file saved with `filename`. A tool result that ends on a captcha, "verify it's you" or block page says so and suggests that the person handles it.
