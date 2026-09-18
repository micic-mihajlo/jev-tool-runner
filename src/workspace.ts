import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { redact } from "./config.js";
import { runProcess } from "./process.js";
import type { CommandSpec, Observation, ToolAction, WorkspaceSnapshot } from "./types.js";

const OMIT_DIRS = [".git", ".agents", ".codex", ".ssh", ".aws", "node_modules", "dist", "build", "coverage", ".next", ".venv", "venv", "__pycache__", "runs"];
const SECRET_NAMES = /^(?:\.env.*|\.npmrc|\.netrc|\.pypirc|auth\.json|credentials.*|secret.*|id_(?:rsa|ed25519|ecdsa).*)$/i;
const SECRET_EXTENSIONS = /(?:\.(?:pem|key|p12|pfx|keystore)$|\.env(?:\..*)?$)/i;
const EXCLUDE_GLOBS = [
  ...OMIT_DIRS.map((dir) => `!**/${dir}/**`),
  "!**/.env*", "!**/*.env", "!**/*.env.*", "!**/.npmrc", "!**/.netrc", "!**/.pypirc", "!**/auth.json",
  "!**/credentials*", "!**/secret*", "!**/id_rsa*", "!**/id_ed25519*", "!**/id_ecdsa*",
  "!**/*.pem", "!**/*.key", "!**/*.p12", "!**/*.pfx", "!**/*.keystore",
];
const RG_FILTERS = EXCLUDE_GLOBS.flatMap((glob) => ["--iglob", glob]);
const SKIP_WORDS = new Set("a an and are as at be been before by can check code do does error failed failing failure file files find fix for from function get goal has have how i in inspect is it its locate me of on or please read relevant repo repository run should source test tests that the their then this to tool use verify want what when where which why with work".split(" "));

export function termsFrom(text: string): string[] {
  const quoted = [...text.matchAll(/[`"']([^`"'\n]{3,80})[`"']/g)].map((match) => match[1]!);
  const words = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_.\/-]{2,60}/g)].map((match) => match[0]);
  const result = [...quoted, ...words].filter((word) => !SKIP_WORDS.has(word.toLowerCase()));
  return [...new Set(result)].slice(0, 12);
}

function action(tool: ToolAction["tool"], args: ToolAction["args"], description: string): ToolAction {
  const hash = createHash("sha256").update(JSON.stringify([tool, args])).digest("hex").slice(0, 16);
  return { id: `call_${hash}`, tool, args, description };
}

export function allowedPath(relative: string): boolean {
  return !path.isAbsolute(relative) && !relative.split(/[\\/]/).some((part) =>
    part === ".." || OMIT_DIRS.includes(part.toLowerCase()) || SECRET_NAMES.test(part) || SECRET_EXTENSIONS.test(part));
}

export class Workspace {
  readonly root: string;
  readonly commands: ReadonlyArray<CommandSpec>;
  private hasGit = false;

  private constructor(root: string, commands: CommandSpec[]) {
    this.root = root;
    this.commands = structuredClone(commands);
  }

  static async create(root: string, commands: CommandSpec[], signal = new AbortController().signal): Promise<Workspace> {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Workspace must be a directory.");
    const workspace = new Workspace(canonical, commands);
    try {
      const result = await runProcess(["git", "-c", "core.fsmonitor=false", "rev-parse", "--is-inside-work-tree"], canonical, signal, 3000);
      workspace.hasGit = result.exitCode === 0;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    return workspace;
  }

  async snapshot(signal: AbortSignal): Promise<WorkspaceSnapshot> {
    const result = await runProcess(["rg", "--files", "--hidden", "--no-require-git", "--null", ...RG_FILTERS], this.root, signal, 10_000, 512_000);
    if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1)) {
      throw new Error("Could not index workspace. Install ripgrep (rg) and check workspace access.");
    }
    const parts = result.stdout.split("\0");
    if (result.truncated) parts.pop();
    const all = parts.filter((file) => file && allowedPath(file)).sort();
    const files = all.slice(0, 5000);
    const hash = createHash("sha256");
    for (let offset = 0; offset < files.length; offset += 50) {
      signal.throwIfAborted();
      const batch = files.slice(offset, offset + 50);
      const metadata = await Promise.all(batch.map(async (file) => {
        try {
          const value = await lstat(path.join(this.root, file));
          return [file, value.size, value.mtimeMs, value.isSymbolicLink()];
        } catch { return [file, "unavailable"]; }
      }));
      hash.update(JSON.stringify(metadata));
    }
    return { files, revision: hash.digest("hex"), truncated: result.truncated || all.length > files.length };
  }

  commandActions(): ToolAction[] {
    return this.commands.map((command) => action(
      "run_command", { commandId: command.id },
      `Run configured command '${command.id}': ${command.description}. argv=${JSON.stringify(command.argv)}`,
    ));
  }

  candidates(goal: string, snapshot: WorkspaceSnapshot, observations: Observation[], maxCandidates: number): ToolAction[] {
    const actions = this.commandActions();
    if (this.hasGit) {
      actions.push(action("git_status", {}, "Read Git status for this workspace to identify modified files."));
      actions.push(action("git_diff", { staged: 0 }, "Read the unstaged Git diff in this workspace."));
      actions.push(action("git_diff", { staged: 1 }, "Read the staged Git diff in this workspace."));
    }
    const terms = termsFrom(goal);
    for (const term of terms.slice(0, 8)) {
      actions.push(action("search_text", { term }, `Search source text for the literal '${term}', returning matching file names and line numbers.`));
    }
    const directories = [...new Set(snapshot.files.map((file) => path.dirname(file)))].sort();
    for (const directory of directories.slice(0, 16)) {
      actions.push(action("list_directory", { directory }, `List indexed files under '${directory}' to discover relevant source and tests.`));
    }
    const recentText = observations.slice(-2).map((observation) => observation.output).join("\n");
    const ranked = snapshot.files.map((file) => {
      const lower = file.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term.toLowerCase()) ? 10 : 0), 0)
        + (recentText.includes(file) ? 30 : 0)
        + (/\.(?:[cm]?[jt]sx?|py|go|rs|java|vue|svelte|rb)$/.test(file) ? 2 : 0)
        + (/^(?:README\.md|package\.json|pyproject\.toml)$/i.test(file) ? 1 : 0);
      return { file, score };
    }).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    for (const { file } of ranked) {
      const reads = observations.filter((observation) => observation.action.tool === "read_file"
        && observation.action.args.path === file && observation.workspaceRevision === snapshot.revision);
      const last = reads.at(-1);
      if (last && !last.nextLine) continue;
      const startLine = last?.nextLine ?? 1;
      actions.push(action("read_file", { path: file, startLine }, `Read '${file}', lines ${startLine}–${startLine + 89}.`));
    }
    const executed = new Set(observations.filter((observation) => observation.workspaceRevision === snapshot.revision).map((observation) => observation.action.id));
    return actions.filter((candidate) => !executed.has(candidate.id)).slice(0, maxCandidates);
  }

  private async resolveFile(relative: string): Promise<string> {
    if (!allowedPath(relative)) throw new Error("File is outside the permitted source inventory.");
    const target = path.resolve(this.root, relative);
    const rel = path.relative(this.root, target);
    if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) throw new Error("File escapes workspace.");
    const canonical = await realpath(target);
    if (canonical !== target) throw new Error("Symlinked source paths are not read by this runner.");
    const info = await lstat(target);
    if (!info.isFile()) throw new Error("Only regular source files can be read.");
    if (info.size > 512_000) throw new Error("File exceeds the 512 KB source-read limit; use a targeted search.");
    return target;
  }

  async execute(candidate: ToolAction, snapshot: WorkspaceSnapshot, signal: AbortSignal): Promise<Omit<Observation, "step" | "workspaceRevision" | "action">> {
    const started = performance.now();
    signal.throwIfAborted();
    if (candidate.tool === "read_file") {
      const relative = String(candidate.args.path);
      if (!snapshot.files.includes(relative)) throw new Error("File was not present in the indexed workspace.");
      const target = await this.resolveFile(relative);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
      if (text.includes("\0")) throw new Error("Binary files are not sent to the decision model.");
      const lines = text.split("\n");
      const startLine = Number(candidate.args.startLine);
      if (!Number.isInteger(startLine) || startLine < 1) throw new Error("Invalid source line.");
      const chunks: string[] = [];
      let length = 0;
      let end = startLine - 1;
      let truncated = false;
      for (let index = startLine - 1; index < Math.min(startLine + 89, lines.length); index++) {
        const line = `${index + 1}: ${lines[index]}`;
        if (chunks.length && length + line.length + 1 > 12_000) break;
        if (line.length > 12_000) {
          chunks.push(`${line.slice(0, 12_000)} [remainder of this oversized line omitted]`);
          truncated = true;
        } else chunks.push(line);
        length += line.length + 1;
        end = index + 1;
      }
      const content = chunks.join("\n");
      return {
        output: redact(`File: ${relative}\nLines ${startLine}-${end} of ${lines.length}\n${content}`),
        exitCode: 0, truncated, durationMs: Math.round(performance.now() - started),
        ...(end < lines.length ? { nextLine: end + 1 } : {}),
      };
    }
    if (candidate.tool === "list_directory") {
      const directory = String(candidate.args.directory);
      const files = snapshot.files.filter((file) => directory === "." || file.startsWith(`${directory}/`));
      return { output: files.slice(0, 250).join("\n"), exitCode: 0, truncated: files.length > 250 || snapshot.truncated, durationMs: Math.round(performance.now() - started) };
    }
    let argv: string[];
    let timeout = 15_000;
    let selectionTruncated = false;
    if (candidate.tool === "search_text") {
      const term = String(candidate.args.term);
      if (!term || term.length > 120) throw new Error("Invalid search term.");
      argv = ["rg", "--line-number", "--no-heading", "--hidden", "--no-require-git", "--fixed-strings", "--ignore-case", "--max-count", "8", ...RG_FILTERS, "--", term, "."];
    } else if (candidate.tool === "git_status") {
      argv = ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short", "--", "."];
    } else if (candidate.tool === "git_diff") {
      const base = ["git", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "diff", "--relative", "--no-ext-diff", "--no-textconv", ...(candidate.args.staged === 1 ? ["--cached"] : [])];
      const changed = await runProcess([...base, "--name-only", "-z", "--", "."], this.root, signal);
      if (changed.exitCode !== 0 || changed.truncated || changed.timedOut) throw new Error("Could not safely enumerate changed files.");
      const files: string[] = [];
      for (const file of changed.stdout.split("\0").filter((file) => file && allowedPath(file))) {
        if (snapshot.files.includes(file)) files.push(file);
        else {
          try { await lstat(path.join(this.root, file)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") files.push(file); }
        }
      }
      const selected = files.slice(0, 100);
      selectionTruncated = files.length > selected.length;
      if (!selected.length) return { output: "No diff for permitted indexed source files.", exitCode: 0, truncated: false, durationMs: Math.round(performance.now() - started) };
      argv = [...base, "--", ...selected];
    } else {
      const command = this.commands.find((entry) => entry.id === candidate.args.commandId);
      if (!command) throw new Error("Command is not in the configured allowlist.");
      argv = command.argv;
      timeout = command.timeoutMs;
    }
    const result = await runProcess(argv, this.root, signal, timeout, 24_000);
    return {
      output: redact([result.stdout, result.stderr && `STDERR:\n${result.stderr}`, result.timedOut && `Command timed out after ${timeout} ms.`].filter(Boolean).join("\n")),
      exitCode: result.exitCode,
      truncated: result.truncated || selectionTruncated,
      durationMs: Math.round(performance.now() - started),
    };
  }
}
