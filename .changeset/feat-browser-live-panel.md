---
"turno-browser": minor
"turno": patch
---

The live view is a panel now: the agent's tab next to a timeline of its steps (the time, what it did, the element or address, how long it took, and whether it failed or was not run), with the pauses, your turns and what changed when you handed the browser back. A line never shows what the agent typed, filled or selected, a script, or an address's query, and every line goes through the same redaction as the agent's results, so vault values stay hidden. When the same call on the same element fails three times in a row, the line and the status say the session looks stuck. New steps and changes of state are announced to screen readers. `turno-browser live` opens the view as an app window of your Chromium browser (`--tab` for a tab of the default browser).

You can take the controls without pausing first: clicking, typing or scrolling on the picture while the agent works, or in the agent's Chrome window, makes the agent's next call wait. The browser goes back to the agent 5 seconds after your last input, or with the view's Hand back button (Resume before), and the waiting call is told that you used the browser and what changed. `turno browser live` without a running server no longer says the view is off when only no server runs.
