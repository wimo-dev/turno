// Opened by turno-browser-mcp in a hidden tab (no tab strip entry), which clicks this button
// with the DevTools protocol's trusted input: Chrome opens a side panel only in answer to a
// user gesture. It opens the panel in every window of the profile, then the host closes it.
document.getElementById("open").addEventListener("click", async () => {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    for (const w of windows) await chrome.sidePanel.open({ windowId: w.id });
    document.title = `opened ${windows.length}`;
  } catch (error) {
    document.title = `failed: ${error && error.message ? error.message : error}`;
  }
});
