import { SERVER_NAME, VERSION } from "../version.js";
import { errorMessage } from "../errors.js";
import { applyBundleArgs, applyBundleEnv } from "../config/bundle-env.js";
import * as log from "../logging/logger.js";
import { helpText, legacyInvocation, parseCommand, type ParsedCommand } from "./dispatch.js";

export async function run(parsed: ParsedCommand): Promise<number> {
  switch (parsed.command) {
    case "version":
      process.stdout.write(`${SERVER_NAME} ${VERSION}\n`);
      return 0;
    case "help":
      process.stdout.write(helpText());
      return 0;
    case "serve": {
      // MCPB expands a `multiple` field only into arguments: serve --attachment-dirs <dir> <dir> …
      const args = applyBundleArgs(parsed.args, process.env);
      // Loaded lazily so `help`/`version` work even when the server's dependencies cannot load.
      const { serve } = await import("../serve.js");
      await serve(args);
      return 0;
    }
    case "http": {
      // Bearer tokens for `serve --http`; same configuration and secret store as the server.
      const { runHttpCli } = await import("./http-command.js");
      return runHttpCli(parsed.args);
    }
    case "setup":
    case "doctor":
    case "accounts":
    case "audit": {
      // Plan 4's admin CLI (Plan 5 added `audit verify`) parses its own arguments and returns the exit code.
      const { runCli } = await import("./run.js");
      return runCli([parsed.command, ...parsed.args]);
    }
  }
}

/** The message `applyBundleEnv` would fail with for this environment, or undefined. Works on a copy. */
export function startupProblem(env: NodeJS.ProcessEnv): string | undefined {
  try {
    applyBundleEnv({ ...env });
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

async function execute(resolve: () => ParsedCommand): Promise<void> {
  try {
    const parsed = resolve();
    if (parsed.command === "serve" && !parsed.args.includes("--http")) {
      // Stdio server: a wrong form entry becomes a setup-problem server instead of an exit.
      try {
        applyBundleEnv(process.env);
      } catch (err) {
        log.initLogger();
        const { serveSetupProblem } = await import("../setup-problem.js");
        serveSetupProblem(errorMessage(err), process.env);
        return;
      }
    } else {
      applyBundleEnv(process.env);
    }
    const code = await run(parsed);
    // `serve` keeps running on stdin; never force an exit code for it.
    if (parsed.command !== "serve") process.exitCode = code;
  } catch (err) {
    process.stderr.write(`${SERVER_NAME}: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  }
}

export async function main(argv: string[]): Promise<void> {
  await execute(() => parseCommand(argv));
}

export async function runLegacy(target: "serve" | "setup", argv: string[]): Promise<void> {
  const { parsed, warning } = legacyInvocation(target, argv);
  process.stderr.write(warning);
  await execute(() => parsed);
}
