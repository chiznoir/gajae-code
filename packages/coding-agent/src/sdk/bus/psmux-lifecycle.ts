import { buildWindowsPowerShellInnerCommand } from "../../gjc-runtime/windows-powershell-command";

const PSMUX_LIFECYCLE_NAMESPACE = "gjc-lifecycle";

function sessionNames(output: string): string[] | undefined {
	const names = output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line =>
			line.includes("\t")
				? line.split("\t")[0]!
				: (line.match(/^([^:]+):\s+\d+\s+windows?\b/)?.[1] ?? (/^[^\s:]+$/.test(line) ? line : "")),
		);
	return names.every(Boolean) ? names : undefined;
}

/** Lists psmux sessions by name; malformed output is deliberately unverifiable. */
export function listPsmuxLifecycleSessions(tmux: string, env: NodeJS.ProcessEnv): string[] | undefined {
	const result = Bun.spawnSync([tmux, "-L", PSMUX_LIFECYCLE_NAMESPACE, "list-sessions", "-F", "#{session_name}"], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim().toLowerCase();
		return /no server running|failed to connect to server|error connecting to/.test(stderr) ? [] : undefined;
	}
	return sessionNames(result.stdout.toString());
}

function hasExactlyOne(names: string[] | undefined, name: string): boolean {
	return names?.filter(candidate => candidate === name).length === 1;
}

/**
 * Creates a Windows psmux lifecycle pane only after an exact-name inventory.
 * psmux has no immutable session id, so callers must treat every uncertain
 * result as terminal and must not attempt cleanup by a guessed target.
 */
export function createPsmuxLifecycleSession(input: {
	tmux: string;
	env: NodeJS.ProcessEnv;
	name: string;
	cwd: string;
	command: readonly string[];
	args: readonly string[];
	environment: Record<string, string>;
}): void {
	const before = listPsmuxLifecycleSessions(input.tmux, input.env);
	if (before === undefined || before.includes(input.name)) throw new Error("gjc_lifecycle_psmux_preflight_uncertain");
	const innerCommand = buildWindowsPowerShellInnerCommand({
		command: input.command,
		args: input.args,
		environment: input.environment,
	});
	const created = Bun.spawnSync(
		[
			input.tmux,
			"-L",
			PSMUX_LIFECYCLE_NAMESPACE,
			"new-session",
			"-d",
			"-s",
			input.name,
			"-c",
			input.cwd,
			innerCommand,
		],
		{ stdout: "pipe", stderr: "pipe", env: input.env },
	);
	if (created.exitCode !== 0 || !hasExactlyOne(listPsmuxLifecycleSessions(input.tmux, input.env), input.name))
		throw new Error("gjc_lifecycle_psmux_spawn_uncertain");
}
