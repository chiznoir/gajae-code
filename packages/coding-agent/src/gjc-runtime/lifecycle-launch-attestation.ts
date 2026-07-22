import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const LIFECYCLE_LAUNCH_ATTESTATION_SCHEMA_VERSION = 1;
const WORKTREE_LAUNCH_BINDING_MAX_DEADLINE_MS = 60_000;
export const LIFECYCLE_LAUNCH_ATTESTATION_ENV = "GJC_LIFECYCLE_LAUNCH_ATTESTATION";
export const LIFECYCLE_LAUNCH_ATTESTATION_FILE_ENV = "GJC_LIFECYCLE_LAUNCH_ATTESTATION_FILE";

export interface WorktreeLaunchBinding {
	launch_id: string;
	nonce: string;
	child_token: string;
	request_id: string;
	session_id: string;
	generation: string;
	run_id: string;
	incarnation: string;
	command_sha256: string;
	expected_runtime_identity: LifecycleRuntimeIdentity;
	expected_runtime_fingerprint: LifecycleRuntimeFingerprint;
	attestation_file: string;
	deadline_ms: number;
	requested_branch: string;
}

export interface LifecycleSourceManifestIdentity {
	package_name: string;
	package_version: string;
	package_relative_path: string;
	resolver_anchor: string;
	manifest_sha256: string;
}
export interface LifecycleSourceClosureManifest {
	digest: string;
	members: readonly {
		packageName: string;
		packageVersion: string;
		packageRelativePath: string;
		resolverAnchor: { specifier: string };
	}[];
}

export function digestLifecycleLaunchCommand(command: readonly string[]): string {
	return crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

export function projectLifecycleSourceManifestIdentity(
	manifest: LifecycleSourceClosureManifest,
): LifecycleSourceManifestIdentity | undefined {
	const member = manifest.members.find(
		candidate =>
			candidate.packageName === "@gajae-code/coding-agent" && candidate.packageRelativePath === "src/cli.ts",
	);
	if (!member || !manifest.digest) return undefined;
	return {
		package_name: member.packageName,
		package_version: member.packageVersion,
		package_relative_path: member.packageRelativePath,
		resolver_anchor: member.resolverAnchor.specifier,
		manifest_sha256: manifest.digest,
	};
}

export interface LifecycleRuntimeFingerprint {
	mode: "source" | "compiled";
	digest: string;
}

export interface LifecycleRuntimeIdentity {
	executable: string;
	argv_sha256: string;
}

export interface LifecycleGitIdentity {
	top_level: string;
	common_dir: string;
	branch: string;
}

export interface LifecycleLaunchAttestation {
	schema_version: typeof LIFECYCLE_LAUNCH_ATTESTATION_SCHEMA_VERSION;
	launch_id: string;
	nonce: string;
	request_id: string;
	session_id: string;
	generation: string;
	run_id: string;
	incarnation: string;
	child_token: string;
	command_sha256: string;
	expected_runtime_identity: LifecycleRuntimeIdentity;
	observed_runtime_identity: LifecycleRuntimeIdentity;
	observed_runtime_fingerprint: LifecycleRuntimeFingerprint;
	canonical_cwd: string;
	git: LifecycleGitIdentity;
	source_manifest: LifecycleSourceManifestIdentity;
	created_at: string;
}

export interface LifecycleLaunchAttestationExpectation {
	launch_id: string;
	nonce: string;
	request_id: string;
	session_id: string;
	generation: string;
	run_id: string;
	incarnation: string;
	child_token: string;
	command_sha256: string;
	expected_runtime_identity: LifecycleRuntimeIdentity;
	canonical_cwd: string;
	git: LifecycleGitIdentity;
	source_manifest: LifecycleSourceManifestIdentity;
	observed_runtime_fingerprint: LifecycleRuntimeFingerprint;
}

function validText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
}

function validIdentity(value: unknown): value is LifecycleRuntimeIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!hasExactKeys(value, ["executable", "argv_sha256"])) return false;
	const identity = value as Partial<LifecycleRuntimeIdentity>;
	return validText(identity.executable) && /^[a-f0-9]{64}$/i.test(identity.argv_sha256 ?? "");
}

function validGit(value: unknown): value is LifecycleGitIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!hasExactKeys(value, ["top_level", "common_dir", "branch"])) return false;
	const git = value as Partial<LifecycleGitIdentity>;
	return validText(git.top_level) && validText(git.common_dir) && validText(git.branch);
}

function validSourceManifest(value: unknown): value is LifecycleSourceManifestIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (
		!hasExactKeys(value, [
			"package_name",
			"package_version",
			"package_relative_path",
			"resolver_anchor",
			"manifest_sha256",
		])
	)
		return false;
	const manifest = value as Partial<LifecycleSourceManifestIdentity>;
	return (
		validText(manifest.package_name) &&
		validText(manifest.package_version) &&
		validText(manifest.package_relative_path) &&
		validText(manifest.resolver_anchor) &&
		/^[a-f0-9]{64}$/i.test(manifest.manifest_sha256 ?? "")
	);
}

function validFingerprint(value: unknown): value is LifecycleRuntimeFingerprint {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!hasExactKeys(value, ["mode", "digest"])) return false;
	const fingerprint = value as Partial<LifecycleRuntimeFingerprint>;
	return (
		(fingerprint.mode === "source" || fingerprint.mode === "compiled") &&
		/^[a-f0-9]{64}$/i.test(fingerprint.digest ?? "")
	);
}
function hasExactKeys(value: object, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function isWorktreeLaunchBinding(value: unknown): value is WorktreeLaunchBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (
		!hasExactKeys(value, [
			"launch_id",
			"nonce",
			"child_token",
			"request_id",
			"session_id",
			"generation",
			"run_id",
			"incarnation",
			"command_sha256",
			"expected_runtime_identity",
			"expected_runtime_fingerprint",
			"attestation_file",
			"deadline_ms",
			"requested_branch",
		])
	)
		return false;
	const binding = value as Partial<WorktreeLaunchBinding>;
	return (
		validText(binding.launch_id) &&
		validText(binding.nonce) &&
		validText(binding.child_token) &&
		validText(binding.request_id) &&
		validText(binding.session_id) &&
		validText(binding.generation) &&
		validText(binding.run_id) &&
		validText(binding.incarnation) &&
		/^[a-f0-9]{64}$/i.test(binding.command_sha256 ?? "") &&
		validIdentity(binding.expected_runtime_identity) &&
		validFingerprint(binding.expected_runtime_fingerprint) &&
		validText(binding.attestation_file) &&
		path.isAbsolute(binding.attestation_file) &&
		typeof binding.deadline_ms === "number" &&
		Number.isSafeInteger(binding.deadline_ms) &&
		binding.deadline_ms > Date.now() &&
		binding.deadline_ms <= Date.now() + WORKTREE_LAUNCH_BINDING_MAX_DEADLINE_MS &&
		validText(binding.requested_branch)
	);
}

/** Parses the untrusted child-launch binding without exposing its contents on failure. */
export function parseWorktreeLaunchBinding(raw: string): WorktreeLaunchBinding {
	try {
		const value: unknown = JSON.parse(raw);
		if (isWorktreeLaunchBinding(value)) return value;
	} catch {
		// The fixed error below intentionally avoids reflecting untrusted binding data.
	}
	throw safeError("binding_invalid");
}

export function isLifecycleLaunchAttestation(value: unknown): value is LifecycleLaunchAttestation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (
		!hasExactKeys(value, [
			"schema_version",
			"launch_id",
			"nonce",
			"request_id",
			"session_id",
			"generation",
			"run_id",
			"incarnation",
			"child_token",
			"command_sha256",
			"expected_runtime_identity",
			"observed_runtime_identity",
			"observed_runtime_fingerprint",
			"canonical_cwd",
			"git",
			"source_manifest",
			"created_at",
		])
	)
		return false;
	const attestation = value as Partial<LifecycleLaunchAttestation>;
	return (
		attestation.schema_version === LIFECYCLE_LAUNCH_ATTESTATION_SCHEMA_VERSION &&
		validText(attestation.launch_id) &&
		validText(attestation.nonce) &&
		validText(attestation.request_id) &&
		validText(attestation.session_id) &&
		validText(attestation.generation) &&
		validText(attestation.run_id) &&
		validText(attestation.incarnation) &&
		validText(attestation.child_token) &&
		/^[a-f0-9]{64}$/i.test(attestation.command_sha256 ?? "") &&
		validIdentity(attestation.expected_runtime_identity) &&
		validIdentity(attestation.observed_runtime_identity) &&
		validFingerprint(attestation.observed_runtime_fingerprint) &&
		validText(attestation.canonical_cwd) &&
		path.isAbsolute(attestation.canonical_cwd) &&
		validGit(attestation.git) &&
		validSourceManifest(attestation.source_manifest) &&
		validText(attestation.created_at)
	);
}

function safeError(code: string): Error {
	return new Error(`lifecycle_launch_attestation_${code}`);
}

function sameIdentity(left: LifecycleRuntimeIdentity, right: LifecycleRuntimeIdentity): boolean {
	return left.executable === right.executable && left.argv_sha256 === right.argv_sha256;
}

function sameFingerprint(left: LifecycleRuntimeFingerprint, right: LifecycleRuntimeFingerprint): boolean {
	return left.mode === right.mode && left.digest === right.digest;
}

function sameGit(left: LifecycleGitIdentity, right: LifecycleGitIdentity): boolean {
	return left.top_level === right.top_level && left.common_dir === right.common_dir && left.branch === right.branch;
}

function sameManifest(left: LifecycleSourceManifestIdentity, right: LifecycleSourceManifestIdentity): boolean {
	return (
		left.package_name === right.package_name &&
		left.package_version === right.package_version &&
		left.package_relative_path === right.package_relative_path &&
		left.resolver_anchor === right.resolver_anchor &&
		left.manifest_sha256 === right.manifest_sha256
	);
}

export function assertLifecycleLaunchAttestation(
	value: unknown,
	expected: LifecycleLaunchAttestationExpectation,
): asserts value is LifecycleLaunchAttestation {
	if (!isLifecycleLaunchAttestation(value)) throw safeError("malformed");
	if (
		value.launch_id !== expected.launch_id ||
		value.nonce !== expected.nonce ||
		value.request_id !== expected.request_id ||
		value.session_id !== expected.session_id ||
		value.generation !== expected.generation ||
		value.run_id !== expected.run_id ||
		value.incarnation !== expected.incarnation ||
		value.child_token !== expected.child_token ||
		value.command_sha256 !== expected.command_sha256 ||
		!sameIdentity(value.expected_runtime_identity, expected.expected_runtime_identity) ||
		!sameIdentity(value.observed_runtime_identity, expected.expected_runtime_identity) ||
		!sameFingerprint(value.observed_runtime_fingerprint, expected.observed_runtime_fingerprint) ||
		value.canonical_cwd !== expected.canonical_cwd ||
		!sameGit(value.git, expected.git) ||
		!sameManifest(value.source_manifest, expected.source_manifest)
	)
		throw safeError("mismatch");
}

/** Writes one immutable launch attestation and verifies its durable on-disk representation. */
export async function writeLifecycleLaunchAttestationExclusive(
	file: string,
	value: LifecycleLaunchAttestation,
): Promise<void> {
	if (!path.isAbsolute(file) || !isLifecycleLaunchAttestation(value)) throw safeError("invalid_write");
	const handle = await fs.open(file, "wx", 0o600).catch(() => {
		throw safeError("exclusive_create_failed");
	});
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
	let reread: unknown;
	try {
		reread = JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		throw safeError("durable_reread_failed");
	}
	if (JSON.stringify(reread) !== JSON.stringify(value)) throw safeError("durable_reread_failed");
}

/** Polls only the supplied path. It never enumerates or infers sibling filenames. */
export async function waitForLifecycleLaunchAttestation(
	file: string,
	expected: LifecycleLaunchAttestationExpectation,
	options: { timeout_ms?: number; poll_ms?: number } = {},
): Promise<LifecycleLaunchAttestation> {
	if (!path.isAbsolute(file)) throw safeError("path_invalid");
	const timeoutMs = options.timeout_ms ?? 5_000;
	const pollMs = options.poll_ms ?? 25;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(pollMs) || pollMs < 1)
		throw safeError("poll_options_invalid");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
			assertLifecycleLaunchAttestation(parsed, expected);
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
				if (error instanceof Error && error.message.startsWith("lifecycle_launch_attestation_")) throw error;
				throw safeError("malformed");
			}
		}
		if (Date.now() >= deadline) throw safeError("timeout");
		await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
}
