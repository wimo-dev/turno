import { assertIdentityId } from "./ids.js";

/**
 * The mcp.toml block that serves one identity through mcpd: with `sharing: "tabs"` every
 * session at once (`exclusive = false`), each in its own tabs, which turno-browser locks; with
 * `"session"` one agent session at a time (`exclusive = true`). An identity shares by tabs unless
 * identity.json says otherwise or it attaches to the user's Chrome, so callers pass the
 * identity's effective sharing. Without it the block is the one-session form, as it always was.
 */
export function manifestSnippet(id: string, options: { sharing?: "session" | "tabs" } = {}): string {
  assertIdentityId(id);
  const shared = options.sharing === "tabs";
  return [
    `[server.browser-${id}]`,
    `command = "turno-browser-mcp"`,
    `args = ["--identity", "${id}"]`,
    `scope = "shared"`,
    ...(shared
      ? ["exclusive = false  # every agent session at once, each in its own tabs"]
      : ["exclusive = true", `lease = "10m"`]),
    `idle = "30m"`,
    "",
  ].join("\n");
}
