import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const BRIDGE_ENV = "GJC_RUNTIME_BINARY";
const LEGACY_BRIDGE_ENV = "GJC_LEGACY_RUNTIME_BINARY";
const GUARD_ENV = "GJC_RUNTIME_BRIDGE_ACTIVE";

export interface GjcRuntimeBridgeResult {
	status: number;
	error?: string;
}

function candidateBinaries(env: NodeJS.ProcessEnv): string[] {
	return [env[BRIDGE_ENV], env[LEGACY_BRIDGE_ENV]].filter(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
}

function isPathLike(command: string): boolean {
	return command.includes("/") || command.includes("\\");
}

function canAttempt(command: string): boolean {
	return !isPathLike(command) || existsSync(command);
}

export function runGjcRuntimeBridge(
	endpoint: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): GjcRuntimeBridgeResult {
	if (env[GUARD_ENV] === "1") {
		return {
			status: 1,
			error: `Refusing recursive gjc runtime bridge for ${endpoint}.`,
		};
	}

	const attempted: string[] = [];
	for (const binary of candidateBinaries(env)) {
		const command = binary.trim();
		if (!canAttempt(command)) continue;
		attempted.push(command);
		const child = spawnSync(command, [endpoint, ...args], {
			stdio: "inherit",
			env: {
				...env,
				[GUARD_ENV]: "1",
			},
		});

		if (child.error) {
			const error = child.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") continue;
			return { status: 1, error: error.message };
		}

		return { status: child.status ?? (child.signal ? 1 : 0) };
	}

	const configured = [env[BRIDGE_ENV], env[LEGACY_BRIDGE_ENV]].filter(Boolean).join(", ");
	return {
		status: 1,
		error: [
			`gjc ${endpoint} requires the private GJC runtime endpoint implementation.`,
			`Set ${BRIDGE_ENV} to a GJC-compatible runtime binary.`,
			configured
				? `Configured runtime candidates failed: ${configured}.`
				: "No gjc runtime binary was found on PATH.",
			attempted.length > 0 ? `Attempted: ${attempted.join(", ")}.` : undefined,
		]
			.filter(Boolean)
			.join("\n"),
	};
}

export async function runBridgedRuntimeEndpoint(endpoint: string, args: string[]): Promise<void> {
	const result = runGjcRuntimeBridge(endpoint, args);
	if (result.error) process.stderr.write(`${result.error}\n`);
	process.exitCode = result.status;
}
