/**
 * Root command for the coding agent CLI.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { THINKING_EFFORTS } from "@gajae-code/ai";
import { APP_NAME, setProjectDir } from "@gajae-code/utils";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { parseArgs } from "../cli/args";
import generatedSourceClosureManifest from "../daemon/lifecycle-source-closure.generated.json";
import { fingerprintWorktreeRuntime, resolveGjcRuntimeArgv } from "../daemon/runtime";
import { launchDefaultTmuxIfNeeded } from "../gjc-runtime/launch-tmux";
import { type PreparedLaunchWorktree, prepareLaunchWorktree } from "../gjc-runtime/launch-worktree";
import {
	digestLifecycleLaunchCommand,
	LIFECYCLE_LAUNCH_ATTESTATION_ENV,
	LIFECYCLE_LAUNCH_ATTESTATION_FILE_ENV,
	LIFECYCLE_LAUNCH_ATTESTATION_SCHEMA_VERSION,
	parseWorktreeLaunchBinding,
	projectLifecycleSourceManifestIdentity,
	writeLifecycleLaunchAttestationExclusive,
} from "../gjc-runtime/lifecycle-launch-attestation";
import {
	GJC_COORDINATOR_SESSION_ATTESTATION_DIGEST_ENV,
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
} from "../gjc-runtime/session-state-sidecar";
import { runRootCommand } from "../main";

function lifecycleGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error("lifecycle_launch_git_identity_unavailable");
	return result.stdout.toString().trim();
}

export interface AttestWorktreeLaunchOptions {
	runtimeExecPath?: string;
	commandArgs?: readonly string[];
	coordinatorEnv?: NodeJS.ProcessEnv;
}

export async function attestWorktreeLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	options: AttestWorktreeLaunchOptions = {},
): Promise<void> {
	const raw = env[LIFECYCLE_LAUNCH_ATTESTATION_ENV];
	const file = env[LIFECYCLE_LAUNCH_ATTESTATION_FILE_ENV];
	if (!raw && !file) return;
	if (!raw || !file) throw new Error("lifecycle_launch_attestation_binding_missing");
	const binding = parseWorktreeLaunchBinding(raw);
	if (file !== binding.attestation_file) throw new Error("lifecycle_launch_attestation_binding_invalid");
	const runtime = resolveGjcRuntimeArgv(options.runtimeExecPath);
	const command = [runtime.execPath, ...runtime.argsPrefix, ...(options.commandArgs ?? process.argv.slice(2))];
	const commandSha = digestLifecycleLaunchCommand(command);
	const observed = await fingerprintWorktreeRuntime({ execPath: options.runtimeExecPath });
	if (
		observed.mode !== binding.expected_runtime_fingerprint.mode ||
		observed.digest !== binding.expected_runtime_fingerprint.digest ||
		runtime.execPath !== binding.expected_runtime_identity.executable ||
		commandSha !== binding.command_sha256
	)
		throw new Error("lifecycle_launch_runtime_identity_mismatch");
	const canonicalCwd = await fs.realpath(cwd);
	const topLevel = await fs.realpath(lifecycleGit(canonicalCwd, ["rev-parse", "--show-toplevel"]));
	const commonDir = await fs.realpath(
		path.resolve(canonicalCwd, lifecycleGit(canonicalCwd, ["rev-parse", "--git-common-dir"])),
	);
	const branch = lifecycleGit(canonicalCwd, ["branch", "--show-current"]);
	if (canonicalCwd !== topLevel || branch !== binding.requested_branch)
		throw new Error("lifecycle_launch_worktree_identity_mismatch");
	await writeLifecycleLaunchAttestationExclusive(file, {
		schema_version: LIFECYCLE_LAUNCH_ATTESTATION_SCHEMA_VERSION,
		launch_id: binding.launch_id,
		nonce: binding.nonce,
		request_id: binding.request_id,
		session_id: binding.session_id,
		generation: binding.generation,
		run_id: binding.run_id,
		incarnation: binding.incarnation,
		child_token: binding.child_token,
		command_sha256: binding.command_sha256,
		expected_runtime_identity: binding.expected_runtime_identity,
		observed_runtime_identity: { executable: runtime.execPath, argv_sha256: commandSha },
		observed_runtime_fingerprint: observed,
		canonical_cwd: canonicalCwd,
		git: { top_level: topLevel, common_dir: commonDir, branch },
		source_manifest: (() => {
			const identity = projectLifecycleSourceManifestIdentity(generatedSourceClosureManifest);
			if (!identity) throw new Error("lifecycle_launch_source_manifest_unavailable");
			return identity;
		})(),
		created_at: new Date().toISOString(),
	});
	(options.coordinatorEnv ?? process.env)[GJC_COORDINATOR_SESSION_ATTESTATION_DIGEST_ENV] = crypto
		.createHash("sha256")
		.update(await fs.readFile(file))
		.digest("hex");
}

import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

const PUBLIC_LAUNCH_FAILURE_CODES = new Set([
	"branch_in_use",
	"invalid_worktree_branch",
	"launch_failed",
	"lifecycle_launch_attestation_binding_invalid",
	"lifecycle_launch_attestation_binding_missing",
	"lifecycle_launch_git_identity_unavailable",
	"lifecycle_launch_runtime_identity_mismatch",
	"lifecycle_launch_source_manifest_unavailable",
	"lifecycle_launch_worktree_identity_mismatch",
	"worktree_add_failed",
	"worktree_dirty",
	"worktree_path_conflict",
	"worktree_target_mismatch",
]);

function projectCoordinatorLaunchFailure(error: unknown): { code: string; message: string } {
	const candidate = (error instanceof Error ? error.message : String(error)).split(":", 1)[0]?.trim() ?? "";
	const code = PUBLIC_LAUNCH_FAILURE_CODES.has(candidate) ? candidate : "launch_failed";
	return { code, message: `Launch failed (${code}).` };
}

export async function persistCoordinatorLaunchFailure(
	error: unknown,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const stateFile = env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (!stateFile) return;
	const { code, message } = projectCoordinatorLaunchFailure(error);
	const now = new Date().toISOString();
	const payload = {
		schema_version: 1,
		session_id: env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || null,
		state: "errored",
		ready_for_input: false,
		updated_at: now,
		current_turn_id: null,
		last_turn_id: null,
		live: false,
		reason: code,
		source: "agent_session_event",
		event: "launch_error",
		cwd,
		workdir: cwd,
		session_file: null,
		final_response: {
			text: message,
			format: "markdown",
			source: "launch_error",
			artifact_path: null,
			truncated: false,
		},
		error: { code, message, recoverable: true },
		...(env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim()
			? { owner_generation: env[GJC_TMUX_OWNER_GENERATION_ENV] ?? null }
			: {}),
	};
	try {
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await Bun.write(stateFile, `${JSON.stringify(payload, null, 2)}\n`);
	} catch {
		// The launch exception is the primary failure; state persistence is best-effort.
	}
}

export default class Index extends Command {
	static description = "Red-claw AI coding assistant";
	static hidden = true;

	static args = {
		messages: Args.string({
			description: "Messages to send (prefix files with @)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		model: Flags.string({
			description: 'Model to use (fuzzy match: "opus", "gpt-5.2", or "openai/gpt-5.2")',
		}),
		smol: Flags.string({
			description: "Smol/fast model for lightweight tasks (or GJC_SMOL_MODEL env)",
		}),
		slow: Flags.string({
			description: "Slow/reasoning model for thorough analysis (or GJC_SLOW_MODEL env)",
		}),
		plan: Flags.string({
			description: "Plan model for architectural planning (or GJC_PLAN_MODEL env)",
		}),
		mpreset: Flags.string({
			description: "Model profile preset to activate for this session",
		}),
		default: Flags.boolean({
			description: "Persist --mpreset as the default model profile",
		}),
		provider: Flags.string({
			description: "Provider to use (legacy; prefer --model)",
		}),
		"api-key": Flags.string({
			description: "API key (defaults to env vars)",
		}),
		credential: Flags.string({
			description:
				"Stored credential selector: email:<addr>, id:<n>, account:<id>, project:<id>, or provider/email:<addr>",
		}),
		"system-prompt": Flags.string({
			description: "System prompt (default: coding assistant prompt)",
		}),
		"append-system-prompt": Flags.string({
			description: "Append text or file contents to the system prompt",
		}),
		"mcp-config": Flags.string({
			description: "Tools-only MCP config file (absolute path)",
		}),
		"allow-home": Flags.boolean({
			description: "Allow starting in ~ without auto-switching to a temp dir",
		}),
		mode: Flags.string({
			description: "Output mode: text (default), json, or acp",
			options: ["text", "json", "acp"],
		}),
		print: Flags.boolean({
			char: "p",
			description: "Non-interactive mode: process prompt and exit",
		}),
		continue: Flags.boolean({
			char: "c",
			description: "Continue previous session",
		}),
		resume: Flags.string({
			char: "r",
			description: "Resume a session (by ID prefix, path, or picker if omitted)",
		}),
		"session-dir": Flags.string({
			description:
				"Explicit session storage directory and lookup override (default uses managed v2 workspace scope)",
		}),
		"no-session": Flags.boolean({
			description: "Don't save session (ephemeral)",
		}),
		models: Flags.string({
			description: "Comma-separated model patterns for Alt+N cycling",
		}),
		"no-tools": Flags.boolean({
			description: "Disable all built-in tools",
		}),
		"no-lsp": Flags.boolean({
			description: "Disable LSP tools, formatting, and diagnostics",
		}),
		"no-pty": Flags.boolean({
			description: "Disable PTY-based interactive bash execution",
		}),
		tmux: Flags.boolean({
			description: "Launch interactive startup inside tmux",
		}),
		tools: Flags.string({
			description: "Comma-separated list of tools to enable (default: all)",
		}),
		thinking: Flags.string({
			description: `Set thinking level: ${THINKING_EFFORTS.join(", ")}`,
			options: [...THINKING_EFFORTS],
		}),
		hook: Flags.string({
			description: "Load a hook/extension file (can be used multiple times)",
			multiple: true,
		}),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file (can be used multiple times)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		"no-skills": Flags.boolean({
			description: "Disable skills discovery and loading",
		}),
		skills: Flags.string({
			description: "Comma-separated glob patterns to filter skills (e.g., git-*,docker)",
		}),
		"no-rules": Flags.boolean({
			description: "Disable rules discovery and loading",
		}),
		export: Flags.string({
			description: "Export session file to HTML and exit",
		}),
		"list-models": Flags.string({
			description: "List available models (with optional fuzzy search)",
		}),
		"no-title": Flags.boolean({
			description: "Disable title auto-generation",
		}),
	};

	static examples = [
		`# Interactive mode\n  ${APP_NAME}`,
		`# Interactive mode with initial prompt\n  ${APP_NAME} "List all .ts files in src/"`,
		`# Include files in initial message\n  ${APP_NAME} @prompt.md @image.png "What color is the sky?"`,
		`# Non-interactive mode (process and exit)\n  ${APP_NAME} -p "List all .ts files in src/"`,
		`# Continue previous session\n  ${APP_NAME} --continue "What did we discuss?"`,
		`# Launch in a sibling git worktree\n  ${APP_NAME} --worktree`,
		`# Use different model (fuzzy matching)\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# Limit model cycling to specific models\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# Pin a stored credential for this session\n  ${APP_NAME} --credential email:me@example.com`,
		`# Activate a model profile for this session\n  ${APP_NAME} --mpreset codex-medium`,
		`# Persist a model profile as the default\n  ${APP_NAME} --mpreset opencodego --default`,
		`# Export a session file to HTML\n  ${APP_NAME} --export ~/.gjc/agent/sessions/v2-<scope>/session.jsonl`,
		`# Use an explicit session storage directory\n  ${APP_NAME} --session-dir ./sessions`,
	];

	static strict = false;

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		const parsed = parseArgs([...args]);
		if (parsed.help || parsed.version) {
			await runRootCommand(parsed, args);
			return;
		}

		let launch: PreparedLaunchWorktree;
		try {
			launch = prepareLaunchWorktree(process.cwd(), args);
		} catch (error) {
			await persistCoordinatorLaunchFailure(error, process.cwd());
			throw error;
		}
		if (launch.worktree.enabled) {
			process.chdir(launch.cwd);
			setProjectDir(launch.cwd);
			try {
				await attestWorktreeLaunch(launch.cwd);
			} catch (error) {
				await persistCoordinatorLaunchFailure(error, launch.cwd);
				throw error;
			}
		}
		const launchParsed = parseArgs(launch.args);
		if (
			launchDefaultTmuxIfNeeded({
				parsed: launchParsed,
				rawArgs: launch.args,
				cwd: launch.cwd,
				worktreeBranch: launch.worktree.enabled && !launch.worktree.detached ? launch.worktree.branchName : null,
				project: launch.cwd,
			})
		)
			return;
		await runRootCommand(launchParsed, launch.args);
	}
}
