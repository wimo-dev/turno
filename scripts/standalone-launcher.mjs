// The entry of the standalone turno-browser executable (scripts/standalone-build.mjs). The
// executable is a Node.js single executable application whose assets are the npm package of
// turno-browser with its dependencies, mounted read-only as a virtual file system next to this
// file. One executable serves both programs of the package:
//   turno-browser <command> ...       the CLI (dist/cli/main.js)
//   turno-browser mcp [flags] ...     the MCP server (dist/bin/mcp.js), also when the
//                                     executable is named turno-browser-mcp
// The package runs some of its own scripts as `process.execPath <script> ...` (the background
// server, the browser installer of patchright-core, the trace viewer). Here process.execPath is
// this executable, so a first argument that is a script inside the mount runs that script, as
// node would.
import fs, { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const pkg = new URL("node_modules/turno-browser/", import.meta.url);

patchVectorIo();

const [head, ...rest] = process.argv.slice(2);
const program = basename(process.execPath).replace(/\.exe$/i, "");

const script = mountScript(head);
if (script) {
  await run(script, rest);
} else if (program === "turno-browser-mcp") {
  await run(fileURLToPath(new URL("dist/bin/mcp.js", pkg)), process.argv.slice(2));
} else if (head === "mcp") {
  await run(fileURLToPath(new URL("dist/bin/mcp.js", pkg)), rest);
} else {
  const { main } = await import(new URL("dist/cli/main.js", pkg).href);
  process.exitCode = await main(process.argv.slice(2));
}

/**
 * The script of the mount a path names, or undefined. The path comes from the process that spawned
 * this one, so it is matched by what follows node_modules/ rather than by the mount point.
 */
function mountScript(arg) {
  if (!arg || !/\.[cm]?js$/.test(arg)) return undefined;
  const at = arg.replaceAll("\\", "/").indexOf("/node_modules/");
  if (at < 0) return undefined;
  const local = join(root, arg.slice(at + 1));
  return existsSync(local) ? local : undefined;
}

/** Runs a script of the mount with the argv node would give it. */
async function run(script, args) {
  process.argv = [process.argv[0], script, ...args];
  await import(pathToFileURL(script).href);
}

/**
 * Node.js 26.13 mounts the virtual file system with handlers that lack the callback forms of
 * writev and readv, so fs.writev throws "h.writev is not a function" for every file, real ones
 * included (nodejs/node#66532, fixed after 26.13.1). A write stream uses writev when it has
 * several chunks queued, which is how patchright-core saves a browser download. The mount is
 * read-only, so a vector call is always for a real file: it becomes one fs.write or fs.read.
 * Nothing changes on a Node.js that has the handlers.
 */
function patchVectorIo() {
  if (!hasBrokenVectorIo()) return;
  fs.writev = (fd, buffers, position, callback) => {
    const cb = typeof position === "function" ? position : callback;
    const at = typeof position === "number" ? position : null;
    const data = Buffer.concat(buffers.map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
    fs.write(fd, data, 0, data.byteLength, at, (err, written) => cb(err, written || 0, buffers));
  };
  fs.readv = (fd, buffers, position, callback) => {
    const cb = typeof position === "function" ? position : callback;
    const at = typeof position === "number" ? position : null;
    const size = buffers.reduce((n, b) => n + b.byteLength, 0);
    const data = Buffer.alloc(size);
    fs.read(fd, data, 0, size, at, (err, read) => {
      if (!err) {
        let offset = 0;
        for (const b of buffers) {
          const view = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
          offset += data.copy(view, 0, offset, Math.min(offset + view.byteLength, read));
          if (offset >= read) break;
        }
      }
      cb(err, read || 0, buffers);
    });
  };
  syncBuiltinESMExports();
}

/** True when fs.writev fails before it reaches the file: the handlers have no writev. */
function hasBrokenVectorIo() {
  try {
    // The largest valid descriptor: no file has it, so a working writev reports EBADF.
    fs.writev(2 ** 31 - 1, [Buffer.alloc(1)], null, () => {});
    return false;
  } catch (err) {
    return err instanceof TypeError && /writev is not a function/.test(err.message);
  }
}
