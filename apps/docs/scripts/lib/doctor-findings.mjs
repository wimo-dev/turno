// Reads the findings `turno doctor`, `turno doctor --security` and `turno browser doctor` can
// report, straight from the TypeScript source: every object literal (or `add(...)` call) that
// carries a level and a text. The checks have no id in the code, so the catalog in
// reference/doctor-checks.json gives each one a stable id; generate.mjs fails when the two
// disagree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Source files that build doctor checks, with the command that reports them. */
export const DOCTOR_SOURCES = [
  { file: "packages/turno/src/cli/commands/doctor.ts", command: "turno doctor" },
  { file: "packages/turno/src/core/profiles.ts", command: "turno doctor", only: "configFindings", level: "warn", area: "config" },
  { file: "packages/turno/src/mcpd/health.ts", command: "turno doctor", area: "gateway" },
  { file: "packages/turno/src/cli/security.ts", command: "turno doctor --security", area: "security" },
  { file: "packages/browser/src/doctor.ts", command: "turno browser doctor" },
];

const LEVELS = new Set(["ok", "warn", "fail", "info"]);

/** A string or template as text: `${expr}` becomes `<expr>`, shortened to its last name. */
function render(node, sf) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += `<${placeholder(span.expression, sf)}>${span.literal.text}`;
    return out;
  }
  if (ts.isParenthesizedExpression(node)) return render(node.expression, sf);
  return undefined;
}

/** A short, readable name for an interpolated expression. */
function placeholder(expr, sf) {
  if (ts.isConditionalExpression(expr)) {
    const a = render(expr.whenTrue, sf);
    const b = render(expr.whenFalse, sf);
    if (a !== undefined && b !== undefined) return a === "" || b === "" ? `${a}${b}` : `${a}|${b}`;
  }
  let e = expr;
  while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  // tildify(path, env), String(x), list.join(", "): describe the value, not the helper.
  while (ts.isCallExpression(e)) {
    const callee = e.expression;
    if (ts.isPropertyAccessExpression(callee) && ["join", "map", "slice", "at", "toString", "toISOString"].includes(callee.name.text)) e = callee.expression;
    else if (e.arguments.length && ["tildify", "String", "listPaths"].includes(callee.getText(sf))) e = e.arguments[0];
    else {
      e = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      break;
    }
    while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  }
  if (ts.isElementAccessExpression(e)) e = e.expression;
  const name = ts.isPropertyAccessExpression(e) ? (e.name.text === "length" ? e.expression.getText(sf).split(".").at(-1) : e.name.text) : (e.getText(sf).match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? "value");
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Every level a level expression can take ("warn", or both sides of a conditional). */
function levelsOf(node) {
  const out = new Set();
  const walk = (n) => {
    if (ts.isStringLiteralLike(n) && LEVELS.has(n.text)) out.add(n.text);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return [...out];
}

function prop(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.getText() === name) return p.name;
  }
  return undefined;
}

/** The `label` of a Fix, looked up through identifiers and helper calls declared in the file. */
function fixLabel(node, sf, labels) {
  if (!node) return undefined;
  if (ts.isObjectLiteralExpression(node)) return render(prop(node, "label"), sf);
  const direct = render(node, sf);
  if (direct !== undefined) return direct;
  const name = ts.isCallExpression(node) ? node.expression.getText(sf) : node.getText(sf);
  return labels.get(name);
}

/** `const x: Fix = { label }` and `function repair(name): Fix { return { label } }` in a file. */
function collectLabels(sf) {
  const labels = new Map();
  const walk = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isObjectLiteralExpression(n.initializer)) {
        const l = render(prop(n.initializer, "label"), sf);
        if (l) labels.set(n.name.getText(sf), l);
      } else {
        const l = render(n.initializer, sf);
        if (l && /^[A-Z_]+$/.test(n.name.getText(sf))) labels.set(n.name.getText(sf), l);
      }
    }
    if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n)) && n.body) {
      const fnName = ts.isFunctionDeclaration(n) ? n.name?.getText(sf) : ts.isVariableDeclaration(n.parent) ? n.parent.name.getText(sf) : undefined;
      if (fnName) {
        const find = (b) => {
          if (ts.isObjectLiteralExpression(b) && prop(b, "label") && prop(b, "run")) {
            const l = render(prop(b, "label"), sf);
            if (l && !labels.has(fnName)) labels.set(fnName, l);
          }
          ts.forEachChild(b, find);
        };
        find(n.body);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return labels;
}

function enclosingFunction(node, sf) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.getText(sf);
    if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.getText(sf);
  }
  return undefined;
}

/**
 * Every finding in the doctor sources: where it is, its levels, its text with placeholders and
 * how it says to fix it. `problem` is true when it can be a warning or a failure.
 */
export function doctorFindings(root) {
  const findings = [];
  for (const src of DOCTOR_SOURCES) {
    const text = readFileSync(join(root, src.file), "utf8");
    const sf = ts.createSourceFile(src.file, text, ts.ScriptTarget.Latest, true);
    const labels = collectLabels(sf);
    const push = (node, fields) => {
      if (fields.text === undefined) return;
      const fn = enclosingFunction(node, sf);
      if (src.only && fn !== src.only) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const levels = fields.levels.length ? fields.levels : src.level ? [src.level] : [];
      findings.push({
        file: src.file,
        line,
        command: src.command,
        area: fields.area ?? src.area ?? fn ?? "",
        levels,
        problem: levels.includes("warn") || levels.includes("fail"),
        text: fields.text,
        ...(fields.fix ? { fix: fields.fix, auto: true } : {}),
        ...(fields.hint ? { hint: fields.hint } : {}),
        ...(fields.manual ? { manual: fields.manual } : {}),
      });
    };
    const how = (obj) => {
      if (!obj || !ts.isObjectLiteralExpression(obj)) return {};
      const fixNode = prop(obj, "fix");
      const fix = fixLabel(fixNode, sf, labels);
      const auto = prop(obj, "auto");
      // The browser doctor writes its fix as a command string; `auto: true` marks the ones --fix runs.
      const isCommandString = fixNode && render(fixNode, sf) !== undefined;
      return {
        ...(fix && (!isCommandString || auto) ? { fix } : {}),
        ...(fix && isCommandString && !auto ? { hint: fix } : {}),
        ...(render(prop(obj, "hint"), sf) ? { hint: render(prop(obj, "hint"), sf) } : {}),
        ...(render(prop(obj, "manual"), sf) ? { manual: render(prop(obj, "manual"), sf) } : {}),
      };
    };
    const walk = (n) => {
      if (ts.isObjectLiteralExpression(n) && prop(n, "text") && (prop(n, "level") || src.level)) {
        const level = prop(n, "level");
        const area = render(prop(n, "area"), sf);
        push(n, { levels: level ? levelsOf(level) : [], text: render(prop(n, "text"), sf), ...(area ? { area } : {}), ...how(n) });
      } else if (ts.isCallExpression(n) && n.expression.getText(sf) === "add" && n.arguments.length >= 3) {
        const [area, level, textNode, extra] = n.arguments;
        push(n, { area: render(area, sf), levels: levelsOf(level), text: render(textNode, sf), ...how(extra) });
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return findings;
}
