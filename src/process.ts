import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

export async function runProcess(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
  maxBytes = 48_000,
): Promise<ProcessResult> {
  signal.throwIfAborted();
  const [executable, ...args] = argv;
  if (!executable) throw new Error("Command requires an executable.");
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", CI: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, env, shell: false, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(sig);
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 500);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => stop();
    signal.addEventListener("abort", onAbort, { once: true });
    const collect = (data: Buffer, stream: "stdout" | "stderr") => {
      const available = Math.max(0, maxBytes - bytes);
      const text = data.subarray(0, available).toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      bytes += data.length;
      if (bytes > maxBytes) truncated = true;
    };
    child.stdout.on("data", (data: Buffer) => collect(data, "stdout"));
    child.stderr.on("data", (data: Buffer) => collect(data, "stderr"));
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (exitCode) => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve({ stdout, stderr, exitCode, truncated, timedOut });
    });
    if (signal.aborted) stop();
  });
}
