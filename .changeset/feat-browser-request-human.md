---
"turno-browser": minor
---

New tool `browser_request_human`: the agent hands the browser to the person for a step only they may do (a password, a captcha, an emailed code, a second factor, accepting terms). The tab comes to the front with a banner that shows the instruction and a Done button, and a ring around the target; every call of every session waits until the step ends on a URL, a selector, Done or the timeout (5 minutes by default, 10 at most). The result says what changed and how many clicks and fields the person made, never what they typed. It works with a Chrome window, or with the live view open on a headless Chrome.
