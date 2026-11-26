---
"turno-browser": minor
"turno": patch
---

The last click is yours: when the agent's `browser_click` would place an order, make a payment, send a message or money, publish a post or confirm a deletion, turno-browser does not click. The agent is told what the click would do and to ask you with `browser_request_human` and `requireHumanClick`, and that step's banner says what the click does, from the page: the order's total, the amount, who a message goes to. The check is conservative: a word that also names a harmless step ("Buy now", "Send", "Post", "Delete") counts only when the page agrees (a checkout with an amount, a message being written, a dialog that warns it cannot be undone), and steps on the way ("Add to cart", "Proceed to checkout", "Send code") never count. `turno-browser set <id> --last-click false` turns it off.

turno-browser shows a notification of the system when the agent waits for you (a person step, a passkey prompt, a captcha no solver answers) and when it is done after a long run, with `osascript` on macOS, `notify-send` on Linux and a PowerShell toast on Windows. The text is redacted like any result and is never run as a script. `turno-browser set <id> --notify false` or `TURNO_BROWSER_NOTIFY=off` turns them off. identity.json format 14 also takes the `notify` and `lastClick` keys; a file that sets one is refused by an older turno-browser.
