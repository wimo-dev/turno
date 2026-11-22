import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserFunctions as BrowserApi } from "../../src/api.js";
import type { VaultInput } from "../../src/cli/context.js";
import { vaultCommand } from "../../src/cli/vault.js";
import { type Sandbox, sandbox } from "../helpers/sandbox.js";
import { cli, ctx, fakeIo } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const PASSWORD = "hunter2-correct-horse";
const TOTP = "JBSWY3DPEHPK3PXP";

interface Added {
  id: string;
  site: string;
  input: { urls: string[]; username: string; password: string; totp?: string };
}

/** The vault calls of turno-browser's API, recording what reaches them. */
function fakeModule(added: Added[], removed: string[], cleared: string[], order: string[] = []): BrowserApi {
  const fake = {
    assertIdentityId: (id: string) => {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id))
        throw Object.assign(new Error(`invalid identity id "${id}"`), { name: "IdentityError" });
    },
    identityExists: (id: string) => id === "work",
    isInUse: () => false,
    inUseBy: () => undefined,
    vaultAdd: async (id: string, site: string, input: Added["input"]) => {
      if (input.totp === "bad") throw Object.assign(new Error("not a TOTP secret"), { name: "TotpError" });
      added.push({ id, site, input });
      return {
        site,
        origins: input.urls.map((u) => new URL(u).origin),
        totp: !!input.totp,
        created: "c",
        updated: "u",
      };
    },
    vaultList: async (id: string) => ({
      identity: id,
      submit: "confirm",
      sites: [
        { site: "github", origins: ["https://github.com"], totp: true, created: "c", updated: "u", stored: true },
        { site: "mail", origins: ["https://mail.example.com"], totp: false, created: "c", updated: "u", stored: false },
      ],
    }),
    vaultRemove: async (_id: string, site: string) => {
      removed.push(site);
      return site === "github";
    },
    vaultSetSubmit: (_id: string, mode: string) => mode,
    vaultClear: async (id: string) => {
      cleared.push(id);
      order.push("clear");
      return 2;
    },
    removeIdentity: () => {
      order.push("remove");
    },
  };
  return fake as unknown as BrowserApi;
}

function setup(input: Partial<VaultInput> = {}) {
  const added: Added[] = [];
  const removed: string[] = [];
  const cleared: string[] = [];
  const order: string[] = [];
  const asked: string[] = [];
  const fake = fakeModule(added, removed, cleared, order);
  const vaultInput: VaultInput = {
    isTty: () => false,
    hidden: async (prompt) => {
      asked.push(prompt);
      return prompt.startsWith("TOTP") ? TOTP : PASSWORD;
    },
    visible: async (prompt) => {
      asked.push(prompt);
      return "alice";
    },
    stdin: async () => `${PASSWORD}\n${TOTP}\n`,
    ...input,
  };
  return {
    added,
    removed,
    cleared,
    order,
    asked,
    browser: cli(fake, { input: vaultInput }).command,
    cmd: vaultCommand(ctx(fake, { input: vaultInput })),
  };
}

/** Everything the command printed, to check no value ever shows. */
const printed = (io: ReturnType<typeof fakeIo>) => [...io.lines, ...io.errors].join("\n");

describe("vault", () => {
  it("adds a site from stdin: the password on line 1, the TOTP secret on line 2, never printed", async () => {
    const { cmd, added } = setup();
    const io = fakeIo(sb.env);
    expect(
      await cmd.run(
        ["add", "work", "github", "--url", "https://github.com/login", "--username", "alice", "--totp"],
        io,
      ),
    ).toBe(0);
    expect(added).toHaveLength(1);
    expect(
      added[0]!.input.password === PASSWORD && added[0]!.input.totp === TOTP && added[0]!.input.username === "alice",
    ).toBe(true);
    expect(added[0]!.input.urls).toEqual(["https://github.com/login"]);
    const out = printed(io);
    expect(out).toMatch(/stored the credentials of github/);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(TOTP);
  });

  it("asks with hidden prompts on a terminal, and refuses to wait for one in an agent session", async () => {
    const { cmd, added, asked } = setup({ isTty: () => true });
    const io = fakeIo({ ...sb.env, TURNO_NO_INPUT: "0" });
    expect(await cmd.run(["add", "work", "github", "--url", "https://github.com", "--totp"], io)).toBe(0);
    expect(asked).toEqual([
      "Username for github: ",
      "Password for github (input hidden): ",
      "TOTP secret or otpauth:// URI (input hidden): ",
    ]);
    expect(added[0]!.input.username).toBe("alice");
    expect(printed(io)).not.toContain(PASSWORD);

    const agent = fakeIo({ ...sb.env, TURNO_NO_INPUT: "", CLAUDECODE: "1" });
    const err = await cmd.run(["add", "work", "github", "--url", "https://github.com"], agent).catch((e: unknown) => e);
    expect(String((err as Error).message ?? err)).toMatch(/stdin/);
  });

  it("needs --url, --username from a pipe, a password and an existing identity", async () => {
    const { cmd, added } = setup({ stdin: async () => "" });
    const run = (args: string[]) => cmd.run(args, fakeIo(sb.env)).then(String, (e: Error) => e.message);
    expect(await run(["add", "work", "github", "--username", "a"])).toMatch(/--url/);
    expect(await run(["add", "work", "github", "--url", "https://github.com"])).toMatch(/--username/);
    expect(await run(["add", "work", "github", "--url", "https://github.com", "--username", "a"])).toMatch(
      /password is empty/,
    );
    expect(await run(["add", "nobody", "github", "--url", "https://github.com", "--username", "a"])).toMatch(
      /does not exist/,
    );
    expect(await run(["add", "work"])).toMatch(/usage: turno-browser vault add/);
    expect(added).toEqual([]);
  });

  it("turns the package's vault errors into one-line failures", async () => {
    const { cmd } = setup({ stdin: async () => `${PASSWORD}\nbad` });
    const msg = await cmd
      .run(["add", "work", "github", "--url", "https://github.com", "--username", "a", "--totp"], fakeIo(sb.env))
      .then(String, (e: Error) => e.message);
    expect(msg).toBe("not a TOTP secret");
  });

  it("writes nothing with --dry-run", async () => {
    const { cmd, added, removed } = setup();
    const io = fakeIo(sb.env);
    expect(
      await cmd.run(["add", "work", "github", "--url", "https://github.com", "--username", "a", "--dry-run"], io),
    ).toBe(0);
    expect(await cmd.run(["remove", "work", "github", "--dry-run"], io)).toBe(0);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(io.lines.join("\n")).toMatch(/\(dry run\)/);
  });

  it("lists sites without values, flags a missing item, and has --json", async () => {
    const { cmd } = setup();
    const io = fakeIo(sb.env);
    expect(await cmd.run(["list", "work"], io)).toBe(1);
    const text = io.lines.join("\n");
    expect(text).toMatch(/github\s+password\+totp\s+https:\/\/github.com/);
    expect(text).toMatch(/mail .*MISSING from the secret store/);
    const json = fakeIo(sb.env);
    expect(await cmd.run(["list", "work", "--json"], json)).toBe(0);
    const doc = JSON.parse(json.lines.join("\n"));
    expect(doc.identity).toBe("work");
    expect(doc.sites).toHaveLength(2);
  });

  it("removes a site and says when there was nothing to remove", async () => {
    const { cmd } = setup();
    expect(await cmd.run(["remove", "work", "github"], fakeIo(sb.env))).toBe(0);
    const io = fakeIo(sb.env);
    expect(await cmd.run(["rm", "work", "mail"], io)).toBe(1);
    expect(io.lines.join("\n")).toMatch(/has no credentials for mail/);
  });

  it("sets the submit policy and refuses another word", async () => {
    const { cmd } = setup();
    const io = fakeIo(sb.env);
    expect(await cmd.run(["submit", "work", "auto"], io)).toBe(0);
    expect(io.lines.join("\n")).toMatch(/submits the sign-in form itself/);
    const msg = await cmd.run(["submit", "work", "always"], fakeIo(sb.env)).then(String, (e: Error) => e.message);
    expect(msg).toMatch(/"confirm".*"auto"/);
  });

  it("has help with examples for the group and each subcommand, through the command group", async () => {
    const { browser } = setup();
    for (const args of [
      ["vault", "--help"],
      ["vault", "add", "--help"],
      ["vault", "list", "--help"],
    ]) {
      const io = fakeIo(sb.env);
      expect(await browser.run(args, io)).toBe(0);
      expect(io.lines.join("\n")).toMatch(/Examples:[\s\S]*turno-browser vault/);
    }
  });
});
