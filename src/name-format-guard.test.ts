import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Fails when a raw player name is interpolated into a template literal (or glued
// on with +) without going through nameMd / namePlain / joinNames. See
// name-format-core.ts for which helper fits which Discord surface.
//
// A "name" here is a property or identifier called displayName, username,
// globalName or nickname, or the result of guildDisplayName(...). Names that were
// already formatted into a differently named variable are out of reach of a text
// scan; the call-site sweep covers those.

const SRC = path.dirname(fileURLToPath(import.meta.url));
const NAME_RE = /\b(?:displayName|username|globalName|nickname)\b|\bguildDisplayName\s*\(/;
const WRAPPERS = ["nameMd(", "namePlain(", "joinNames("];

// "relative/path.ts:line" -> one-word reason. Every entry needs a reason that
// says why the name never reaches a Discord surface.
// audit = AuditLog summary (DB only, web admin HTML-escapes it); log = console/thrown error;
// data = cached tiebreakNote read by the web, never posted by the bot; script = dev seed.
const ALLOWLIST: Readonly<Record<string, string>> = {
  "bot-purge.ts:93": "log",
  "bot-purge.ts:101": "audit",
  "commands/admin.ts:440": "audit",
  "commands/admin.ts:732": "audit",
  "commands/admin.ts:871": "audit",
  "commands/admin.ts:943": "audit",
  "commands/admin.ts:1056": "audit",
  "commands/admin.ts:1086": "audit",
  "commands/admin.ts:1161": "audit",
  "commands/challenge.ts:252": "audit",
  "commands/match-buttons.ts:1033": "audit",
  "commands/match-buttons.ts:1247": "audit",
  "commands/match-buttons.ts:1768": "audit",
  "display-name-refresh.ts:63": "log",
  "display-name-refresh.ts:72": "log",
  "league-match-invite.ts:239": "audit",
  "players.ts:42": "log",
  "scripts/seed-test.ts:85": "script",
  "standings.ts:388": "data",
  "standings.ts:389": "data",
  "standings.ts:404": "data",
  "standings.ts:405": "data",
  "standings.ts:411": "data",
  "standings.ts:412": "data",
  "standings.ts:423": "data",
  "standings.ts:424": "data",
  "standings.ts:432": "data",
  "standings.ts:433": "data",
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// A comment line starts with a double slash, a slash-star, or a block-comment star followed by space or slash. Not a bolded name like a double-star template.
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || /^\*(?:\s|\/|$)/.test(trimmed);
}

/** Remove every balanced `wrapper( ... )` call from an expression. */
export function stripWrappedCalls(expr: string): string {
  let out = expr;
  for (;;) {
    let start = -1;
    for (const w of WRAPPERS) {
      const i = out.indexOf(w);
      if (i !== -1 && (start === -1 || i < start)) start = i;
    }
    if (start === -1) return out;
    let depth = 0;
    let end = -1;
    for (let i = out.indexOf("(", start); i < out.length; i++) {
      if (out[i] === "(") depth++;
      else if (out[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) return out.slice(0, start);
    out = out.slice(0, start) + out.slice(end + 1);
  }
}

/** 1-based line numbers of `${...}` expressions that hold an unwrapped name. */
export function findRawNameInterpolations(source: string): number[] {
  const lines: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "$" || source[i + 1] !== "{") continue;
    let depth = 0;
    let j = i + 1;
    for (; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}" && --depth === 0) break;
    }
    const expr = source.slice(i + 2, j);
    if (NAME_RE.test(stripWrappedCalls(expr))) {
      const lineStart = source.lastIndexOf("\n", i) + 1;
      const linePrefix = source.slice(lineStart, i).trimStart();
      if (!isCommentLine(linePrefix)) {
        lines.push(source.slice(0, i).split("\n").length);
      }
    }
  }
  return lines;
}

/** 1-based line numbers where a name is glued onto a string literal with `+`. */
export function findRawNameConcats(source: string): number[] {
  const out: number[] = [];
  source.split("\n").forEach((line, idx) => {
    const t = line.trimStart();
    if (isCommentLine(t)) return;
    const code = stripWrappedCalls(line);
    if (
      /["'`]\s*\+\s*[\w.?!()]*(?:displayName|username|globalName|nickname)\b/.test(code) ||
      /(?:displayName|username|globalName|nickname)\b[\w.?!()]*\s*\+\s*["'`]/.test(code)
    ) {
      out.push(idx + 1);
    }
  });
  return out;
}

describe("detectors", () => {
  test.each([
    ["raw", "const a = `hi ${p.displayName}`;", [1]],
    ["wrapped md", "const a = `hi ${nameMd(p.displayName)}`;", []],
    ["wrapped plain", "const a = `hi ${namePlain(p.username)}`;", []],
    ["nested wrapper", "const a = `hi ${x ? nameMd(p.displayName) : ''}`;", []],
    ["fallback outside wrapper", "const a = `hi ${nameMd(p.displayName) ?? p.username}`;", [1]],
    ["guildDisplayName raw", "const a = `hi ${await guildDisplayName(g, id)}`;", [1]],
    ["comment", "// `${p.displayName}` is fine in a comment", []],
    ["second line", "x;\nconst a = `hi ${p.nickname}`;", [2]],
    ["bold-led continuation", "const a = `x\n**${p.displayName}**`;", [2]],
    ["block comment line", "/**\n * `${p.displayName}`\n */", []],
  ] as const)("template: %s", (_label, source, expected) => {
    expect(findRawNameInterpolations(source)).toEqual(expected);
  });

  test.each([
    ["concat after", 'const a = "hi " + p.displayName;', [1]],
    ["concat before", 'const a = p.username + " wins";', [1]],
    ["wrapped", 'const a = "hi " + nameMd(p.displayName);', []],
    ["no concat", "const a = p.displayName;", []],
  ] as const)("concat: %s", (_label, source, expected) => {
    expect(findRawNameConcats(source)).toEqual(expected);
  });
});

describe("no raw player names in Discord-bound strings", () => {
  const files = listSourceFiles(SRC);

  test("source files were found", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("every allowlist entry is still needed", () => {
    const hits = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      for (const line of [...findRawNameInterpolations(source), ...findRawNameConcats(source)]) {
        hits.add(`${rel}:${line}`);
      }
    }
    const stale = Object.keys(ALLOWLIST).filter((k) => !hits.has(k));
    expect(stale).toEqual([]);
  });

  test("no unwrapped name interpolation or concat outside the allowlist", () => {
    const offenders = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      for (const line of [...findRawNameInterpolations(source), ...findRawNameConcats(source)]) {
        const key = `${rel}:${line}`;
        if (!(key in ALLOWLIST)) offenders.add(key);
      }
    }
    expect([...offenders]).toEqual([]);
  });
});
