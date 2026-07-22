import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readLinuxProcStartTime } from "./linux-proc";
import { assertSafePathComponent } from "./session-layout";
import { lifecyclePaths } from "./tmux-owner-isolation";

export const MANAGED_OWNER_SUPERVISOR_ARG = "--internal-managed-owner-supervisor";
export const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
export const MANAGED_OWNER_COMMAND_ENV = "GJC_MANAGED_OWNER_COMMAND_JSON";
export const MANAGED_OWNER_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
export const MANAGED_OWNER_GENERATION_ENV = "GJC_TMUX_OWNER_GENERATION";
export const MANAGED_OWNER_STATE_DIR_ENV = "GJC_TMUX_OWNER_STATE_DIR";
export const MANAGED_OWNER_RUN_ID_ENV = "GJC_MANAGED_OWNER_RUN_ID";
export const MANAGED_OWNER_INCARNATION_ENV = "GJC_MANAGED_OWNER_INCARNATION";
export const MANAGED_OWNER_BINDING_REF_ENV = "GJC_MANAGED_OWNER_BINDING_REF";
export const MANAGED_OWNER_LAUNCH_BINDING_REF_ENV = MANAGED_OWNER_BINDING_REF_ENV;

export interface ManagedOwnerLaunchBindingRef {
	schema_version: 1;
	launch_id: string;
	session_id: string;
	generation: string;
	run_id: string;
	endpoint_incarnation: string;
	child_token: string;
	child_binding_basename: string;
	command_sha256: string;
}

export interface ManagedOwnerBinding {
	schema_version: 2;
	generation: string;
	session_id: string;
	run_id: string;
	endpoint_incarnation: string;
	child_token: string;
	command: string[];
	command_sha256: string;
	supervisor_pid: number;
	supervisor_start_time: string;
	created_at: string;
}

export interface ManagedOwnerSigabrtReceipt {
	schema_version: 2;
	generation: string;
	session_id: string;
	run_id: string;
	endpoint_incarnation: string;
	child_token: string;
	command_sha256: string;
	supervisor_pid: number;
	supervisor_start_time: string;
	child_pid: number;
	child_start_time: string;
	signal: "SIGABRT";
	signal_number: 6;
	exit_code: number | null;
	received_at: string;
}

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`managed_owner_${name.toLowerCase()}_missing`);
	return value;
}

function lifecycleRoot(): { root: string; generation: string; sessionId: string; runId: string; incarnation: string } {
	const stateDir = requiredEnvironment(MANAGED_OWNER_STATE_DIR_ENV);
	const sessionId = requiredEnvironment(MANAGED_OWNER_SESSION_ID_ENV);
	const generation = requiredEnvironment(MANAGED_OWNER_GENERATION_ENV);
	const runId = requiredEnvironment(MANAGED_OWNER_RUN_ID_ENV);
	const incarnation = requiredEnvironment(MANAGED_OWNER_INCARNATION_ENV);
	for (const [value, label] of [
		[sessionId, "managed owner session id"],
		[generation, "managed owner generation"],
		[runId, "managed owner run id"],
		[incarnation, "managed owner incarnation"],
	] as const)
		assertSafePathComponent(value, label);
	if (!path.isAbsolute(stateDir)) throw new Error("managed_owner_lifecycle_path_unsafe");
	const root = lifecyclePaths(stateDir, sessionId, generation).root;
	if (!root.startsWith(`${path.resolve(stateDir)}${path.sep}`)) throw new Error("managed_owner_lifecycle_path_unsafe");
	return { root, generation, sessionId, runId, incarnation };
}

function commandDigest(command: readonly string[]): string {
	return crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

async function writeDurableExclusive(file: string, value: object): Promise<void> {
	const handle = await fs.open(file, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const directory = await fs.open(path.dirname(file), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
	const persisted = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
	if (JSON.stringify(persisted) !== JSON.stringify(value)) throw new Error("managed_owner_durable_reread_failed");
}
export async function writeManagedOwnerLaunchBindingRef(
	file: string,
	value: ManagedOwnerLaunchBindingRef,
): Promise<void> {
	if (
		!path.isAbsolute(file) ||
		!/^launch-[A-Za-z0-9_-]+\.binding-ref\.json$/.test(path.basename(file)) ||
		!/^child-[A-Za-z0-9_-]+\.binding\.json$/.test(value.child_binding_basename) ||
		!Object.values(value).every(item => typeof item === "string" || item === 1) ||
		!/^[a-f0-9]{64}$/i.test(value.command_sha256)
	)
		throw new Error("managed_owner_launch_binding_ref_invalid");
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await writeDurableExclusive(file, value);
}

async function bindingReference(input: {
	root: string;
	generation: string;
	sessionId: string;
	runId: string;
	incarnation: string;
	command: readonly string[];
}): Promise<{ file: string; childToken: string }> {
	const configured = process.env[MANAGED_OWNER_LAUNCH_BINDING_REF_ENV]?.trim();
	if (!configured) {
		const childToken = crypto.randomUUID();
		return { file: path.join(input.root, `child-${childToken}.binding.json`), childToken };
	}
	if (
		!path.isAbsolute(configured) ||
		path.dirname(configured) !== input.root ||
		!/^launch-[A-Za-z0-9_-]+\.binding-ref\.json$/.test(path.basename(configured))
	)
		throw new Error("managed_owner_launch_binding_ref_unsafe");
	let reference: unknown;
	try {
		reference = JSON.parse(await fs.readFile(configured, "utf8"));
	} catch {
		throw new Error("managed_owner_launch_binding_ref_invalid");
	}
	if (!reference || typeof reference !== "object" || Array.isArray(reference))
		throw new Error("managed_owner_launch_binding_ref_invalid");
	const ref = reference as Record<string, unknown>;
	const required = [
		"schema_version",
		"launch_id",
		"session_id",
		"generation",
		"run_id",
		"endpoint_incarnation",
		"child_token",
		"child_binding_basename",
		"command_sha256",
	];
	if (Object.keys(ref).length !== required.length || required.some(key => !(key in ref)))
		throw new Error("managed_owner_launch_binding_ref_invalid");
	if (
		ref.schema_version !== 1 ||
		ref.session_id !== input.sessionId ||
		ref.generation !== input.generation ||
		ref.run_id !== input.runId ||
		ref.endpoint_incarnation !== input.incarnation ||
		ref.command_sha256 !== commandDigest(input.command) ||
		typeof ref.launch_id !== "string" ||
		typeof ref.child_token !== "string" ||
		typeof ref.child_binding_basename !== "string"
	)
		throw new Error("managed_owner_launch_binding_ref_mismatch");
	try {
		assertSafePathComponent(ref.launch_id, "managed owner launch id");
		assertSafePathComponent(ref.child_token, "managed owner child token");
	} catch {
		throw new Error("managed_owner_launch_binding_ref_invalid");
	}
	if (
		path.basename(configured) !== `launch-${ref.launch_id}.binding-ref.json` ||
		ref.child_binding_basename !== `child-${ref.child_token}.binding.json`
	)
		throw new Error("managed_owner_launch_binding_ref_mismatch");
	return { file: path.join(input.root, ref.child_binding_basename), childToken: ref.child_token };
}

function childCommand(): string[] {
	const command = JSON.parse(requiredEnvironment(MANAGED_OWNER_COMMAND_ENV)) as unknown;
	if (!Array.isArray(command) || command.length === 0 || command.some(value => typeof value !== "string" || !value))
		throw new Error("managed_owner_command_invalid");
	return command;
}

export function isManagedOwnerSupervisorArgv(args: readonly string[]): boolean {
	return args.length === 1 && args[0] === MANAGED_OWNER_SUPERVISOR_ARG;
}

/** Runs one exact child and publishes authority only for a directly observed Linux signal 6. */
export async function runManagedOwnerSupervisor(): Promise<void> {
	const { root, generation, sessionId, runId, incarnation } = lifecycleRoot();
	const command = childCommand();
	const supervisorStartTime = await readLinuxProcStartTime(process.pid);
	if (!supervisorStartTime) throw new Error("managed_owner_supervisor_start_time_unavailable");
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const { file: bindingFile, childToken } = await bindingReference({
		root,
		generation,
		sessionId,
		runId,
		incarnation,
		command,
	});
	const binding: ManagedOwnerBinding = {
		schema_version: 2,
		generation,
		session_id: sessionId,
		run_id: runId,
		endpoint_incarnation: incarnation,
		child_token: childToken,
		command,
		command_sha256: commandDigest(command),
		supervisor_pid: process.pid,
		supervisor_start_time: supervisorStartTime,
		created_at: new Date().toISOString(),
	};
	await writeDurableExclusive(bindingFile, binding);
	const child = Bun.spawn({
		cmd: command,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: {
			...process.env,
			[MANAGED_OWNER_CHILD_TOKEN_ENV]: childToken,
			[MANAGED_OWNER_BINDING_REF_ENV]: bindingFile,
		},
	});
	const childStartTime = await readLinuxProcStartTime(child.pid);
	if (!childStartTime) throw new Error("managed_owner_child_start_time_unavailable");
	const exitCode = await child.exited;
	if (child.signalCode === "SIGABRT") {
		const receipt: ManagedOwnerSigabrtReceipt = {
			schema_version: 2,
			generation,
			session_id: sessionId,
			run_id: runId,
			endpoint_incarnation: incarnation,
			child_token: childToken,
			command_sha256: binding.command_sha256,
			supervisor_pid: process.pid,
			supervisor_start_time: supervisorStartTime,
			child_pid: child.pid,
			child_start_time: childStartTime,
			signal: "SIGABRT",
			signal_number: 6,
			exit_code: exitCode,
			received_at: new Date().toISOString(),
		};
		await writeDurableExclusive(path.join(root, `sigabrt-${childToken}.receipt.json`), receipt);
		process.exitCode = 134;
		return;
	}
	process.exitCode = exitCode;
}
