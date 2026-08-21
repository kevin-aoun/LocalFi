/**
 * A terminal REPL for chat capture.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/agent-cli.ts
 *   npm run agent
 *   npm run agent -- --once "10 groceries"
 *   npm run agent -- --debug
 *
 * ============================================================================
 * ⚠  THE SINGLE-WRITER RULE — READ THIS BEFORE RUNNING IT
 * ============================================================================
 *
 * `lib/db/client.ts` serializes work in-process and holds a cross-process writer
 * lease while the SQLite image is open. This CLI therefore refuses to start if
 * the app or another maintenance command owns the same database.
 *
 * Do not run it at the same time as `bun run dev`, `bun run start` or the Docker
 * container against the same database. The lease fails closed, and stopping the
 * other process first keeps the operational boundary unambiguous.
 *
 * For anything experimental, point it at an already-initialized disposable vault:
 *
 *   BUDGET_DB_PATH=/tmp/scratch.db LOCALFI_VAULT_PASSPHRASE=... \
 *     bun run agent -- --once "10 groceries"
 *
 * ============================================================================
 * WHAT THIS FILE IS AND IS NOT
 * ============================================================================
 *
 * It is a transport: read a line, call `handleMessage`, print the reply. Every
 * routing, validation, confirmation and undo decision lives in
 * `lib/agent/handle.ts` and `lib/agent/execute.ts`, so the terminal, the HTTP
 * route and the Telegram worker cannot drift apart in what they allow.
 */
import readline from "node:readline";

import { getSettings } from "@/app/actions/settings";
import { checkNeedleHealth, handleMessage, NEEDLE_START_HINT } from "@/lib/agent/handle";
import { needleBudget } from "@/lib/agent/tool-schema";
import { AGENT_TOOLS } from "@/lib/agent/tools";
import {
  authorizeDatabaseVaultFromEnvironment,
  resolveDbPath,
} from "@/lib/db/client";
import { isDateKey, todayKey, type DateKey } from "@/lib/dates";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type Options = {
  once: string | null;
  debug: boolean;
  today: DateKey;
  help: boolean;
};

const USAGE = `Chat capture, in a terminal.

Usage:
  bun run agent                          interactive REPL
  bun run agent -- --once "10 groceries" one message, then exit
  bun run agent -- --debug               show raw model output, tool and latency
  bun run agent -- --today 2026-07-29    override today (relative dates only —
                                         a message with no date still lands on
                                         the real day; see lib/agent/tools.ts)

Environment:
  BUDGET_DB_PATH   explicit existing vault to use instead of the default path.
  LOCALFI_VAULT_PASSPHRASE
                   required for an encrypted owner vault; scope it to this command.
  AGENT_DEBUG=1    same as --debug.

In the REPL: send a message, or /help. Ctrl-D or /exit to quit.`;

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    once: null,
    debug: process.env.AGENT_DEBUG === "1" || process.env.AGENT_DEBUG === "true",
    today: todayKey(),
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--debug" || arg === "-d") {
      options.debug = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--once" || arg === "-1") {
      // The value may be empty ("" is a real test case: it should hint, not crash),
      // so presence is checked by index, never by truthiness.
      if (i + 1 >= argv.length) fail("--once needs a message, e.g. --once \"10 groceries\"");
      options.once = argv[++i];
    } else if (arg.startsWith("--once=")) {
      options.once = arg.slice("--once=".length);
    } else if (arg === "--today") {
      if (i + 1 >= argv.length) fail("--today needs a YYYY-MM-DD date");
      options.today = requireDateKey(argv[++i]);
    } else if (arg.startsWith("--today=")) {
      options.today = requireDateKey(arg.slice("--today=".length));
    } else {
      fail(`I don't know the option ${JSON.stringify(arg)}. Try --help.`);
    }
  }
  return options;
}

function requireDateKey(value: string): DateKey {
  if (!isDateKey(value)) fail(`--today must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  return value;
}

function fail(message: string): never {
  console.error(`agent-cli: ${message}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

/**
 * Everything a person needs in order to trust what they are about to do.
 *
 * The database path is first and unabbreviated. "Which database did I just write
 * to" must never be a question anyone has to answer by reading source code.
 */
async function banner(options: Options): Promise<void> {
  const dbPath = resolveDbPath();
  const overridden = (process.env.BUDGET_DB_PATH ?? "").trim() !== "";
  const budget = needleBudget();
  const health = await checkNeedleHealth();

  const lines: string[] = [];
  lines.push("budget agent CLI");
  lines.push("");
  lines.push(`  database   ${dbPath}`);
  lines.push(
    overridden
      ? "             (from BUDGET_DB_PATH — a scratch database, good)"
      : "             ⚠  THIS IS THE REAL DATABASE. Use BUDGET_DB_PATH=/tmp/x.db to test.",
  );
  lines.push(
    "  ⚠  single writer: stop `bun run dev`, `bun run start` or the Docker",
  );
  lines.push(
    "     container before using this database. The cross-process lease refuses",
  );
  lines.push("     concurrent access rather than risking a whole-generation overwrite.");
  lines.push("");
  lines.push(
    `  tools      ${AGENT_TOOLS.length} tools, ~${budget.estimatedTokens} tokens of ${budget.limit} ` +
      `(${budget.bytes} bytes) ${budget.fits ? "— fits" : "— DOES NOT FIT, model calls refused"}`,
  );
  lines.push(`  model      ${health.ready ? "ready" : "NOT ready"} — ${health.detail}`);
  if (!health.ready) {
    // The client's reason often already names the command; repeating it reads
    // like two different instructions.
    if (!health.detail.includes(NEEDLE_START_HINT)) {
      lines.push(`             start it with: ${NEEDLE_START_HINT}`);
    }
    lines.push("             slash commands work regardless — try /help");
  }
  lines.push(`  today      ${options.today}`);

  // Quick commands come from the database, so this doubles as a read-path check:
  // if the file is missing or unreadable you find out here, not mid-message.
  try {
    const settings = await getSettings();
    const names = settings.quickCommands.map((cmd) => `/${cmd.command.replace(/^\//, "")}`);
    lines.push(
      `  shortcuts  ${names.length === 0 ? "none configured" : names.join(" ")}`,
    );
  } catch (error) {
    lines.push(
      `  shortcuts  could not read settings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (options.debug) lines.push("  debug      on");
  lines.push("");
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------------

/** Print a reply. Returns the reply's status so `--once` can pick an exit code. */
async function send(message: string, options: Options): Promise<string> {
  const started = Date.now();
  const reply = await handleMessage(message, {
    today: options.today,
    debug: options.debug,
  });
  const elapsed = Date.now() - started;

  console.log(reply.text);

  if (options.debug) {
    const parts = [`source=${reply.source}`, `status=${reply.status}`];
    if (reply.toolName) parts.push(`tool=${reply.toolName}`);
    parts.push(`total=${elapsed}ms`);
    if (reply.debug?.ms !== undefined) parts.push(`model=${reply.debug.ms}ms`);
    console.log(`  [${parts.join(" ")}]`);
    if (reply.debug?.raw !== undefined) console.log(`  [raw] ${reply.debug.raw}`);
    if (reply.debug?.calls !== undefined) {
      console.log(`  [calls] ${JSON.stringify(reply.debug.calls)}`);
    }
  }
  return reply.status;
}

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

const EXIT_WORDS = new Set(["/exit", "/quit", ".exit", ":q"]);

async function repl(options: Options): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = "> ";

  // Messages are handled strictly one at a time. Concurrent handling would put
  // two writes into the executor at once, and the confirmation store is keyed by
  // "the newest pending" — interleaving them would let /yes answer the wrong one.
  let chain: Promise<void> = Promise.resolve();

  rl.setPrompt(prompt);
  rl.prompt();

  rl.on("line", (line) => {
    const message = line.trim();
    chain = chain.then(async () => {
      if (EXIT_WORDS.has(message.toLowerCase())) {
        rl.close();
        return;
      }
      if (message === "") {
        rl.prompt();
        return;
      }
      try {
        await send(message, options);
      } catch (error) {
        // handleMessage does not throw; this is the belt to its braces.
        console.error(
          `That failed and nothing was saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      rl.prompt();
    });
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      // Let a message that is still running finish before the process exits.
      chain.then(() => {
        console.log("bye");
        resolve();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Send `console.debug` to nowhere unless --debug is on.
 *
 * `lib/revalidate.ts` debug-logs once per path on every write, because
 * `revalidatePath` throws outside a request scope — which is always, here. Two
 * lines of Next.js internals before every reply drowns the reply. Only
 * `console.debug` is muted: warnings and errors still print, so a real failure
 * cannot be hidden by this.
 */
function quietDebugLogs(): void {
  console.debug = () => {};
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.debug) quietDebugLogs();

  const releaseAuthorization = await authorizeDatabaseVaultFromEnvironment();
  try {
    await banner(options);

    if (options.once !== null) {
      const status = await send(options.once, options);
      // A non-zero code on a failed write is what makes this usable in a smoke test.
      process.exitCode = status === "error" ? 1 : 0;
      return;
    }

    await repl(options);
  } finally {
    await releaseAuthorization();
  }
}

main().then(
  () => {
    // sql.js holds the database in memory; nothing to flush, but the readline
    // handle can keep the loop alive. Exit deliberately.
    process.exit(process.exitCode ?? 0);
  },
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  },
);
