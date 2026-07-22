import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { attestWorktreeLaunch, persistCoordinatorLaunchFailure } from "@gajae-code/coding-agent/commands/launch";
import {
	digestLifecycleLaunchCommand,
	LIFECYCLE_LAUNCH_ATTESTATION_ENV,
	LIFECYCLE_LAUNCH_ATTESTATION_FILE_ENV,
} from "@gajae-code/coding-agent/gjc-runtime/lifecycle-launch-attestation";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	readTerminalRuntimeStateMarker,
} from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";

describe("persistCoordinatorLaunchFailure", () => {
	it("persists the exact managed owner generation without normalizing it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-error-"));
		try {
			const stateFile = path.join(root, "runtime.json");
			const generation = "owner-generation-9c5542";
			await persistCoordinatorLaunchFailure(new Error("launch_failed: detail"), root, {
				[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
				[GJC_COORDINATOR_SESSION_ID_ENV]: "coordinator-123",
				[GJC_TMUX_OWNER_GENERATION_ENV]: generation,
			});
			const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as Record<string, unknown>;
			expect(state.cwd).toBe(root);
			expect(state.workdir).toBe(root);
			expect(state.owner_generation).toBe(generation);
			await expect(
				readTerminalRuntimeStateMarker({
					stateFile,
					sessionId: "coordinator-123",
					cwd: root,
				}),
			).resolves.toEqual({ terminal: true, state: "errored" });
			await persistCoordinatorLaunchFailure(new Error("launch_failed"), root, {
				[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
				[GJC_COORDINATOR_SESSION_ID_ENV]: "coordinator-123",
			});
			const missing = JSON.parse(await fs.readFile(stateFile, "utf8")) as Record<string, unknown>;
			expect(Object.hasOwn(missing, "owner_generation")).toBe(true);
			expect(missing.owner_generation).toBeNull();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("projects path and token diagnostics to a stable public code", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-redaction-"));
		try {
			const stateFile = path.join(root, "runtime.json");
			const privateDiagnostic = "worktree_dirty:/private/repo?token=super-secret";
			await persistCoordinatorLaunchFailure(new Error(privateDiagnostic), root, {
				[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
			});

			const receipt = await fs.readFile(stateFile, "utf8");
			const state = JSON.parse(receipt) as {
				reason: string;
				error: { code: string; message: string; recoverable: boolean };
			};
			expect(state.reason).toBe("worktree_dirty");
			expect(state.error).toEqual({
				code: "worktree_dirty",
				message: "Launch failed (worktree_dirty).",
				recoverable: true,
			});
			expect(receipt).not.toContain("/private/repo");
			expect(receipt).not.toContain("super-secret");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not let a receipt-write failure mask the primary launch failure", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-write-failure-"));
		try {
			const primary = new Error("worktree_dirty:/private/repo?token=super-secret");
			await expect(
				persistCoordinatorLaunchFailure(primary, root, {
					[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: root,
				}),
			).resolves.toBeUndefined();
			expect(primary.message).toBe("worktree_dirty:/private/repo?token=super-secret");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
describe("attestWorktreeLaunch", () => {
	it("fails closed before runtime or Git access for incomplete and malformed environments", async () => {
		await expect(
			attestWorktreeLaunch("/definitely/not/a/worktree", {
				GJC_LIFECYCLE_LAUNCH_ATTESTATION: "{}",
			}),
		).rejects.toThrow("lifecycle_launch_attestation_binding_missing");
		await expect(
			attestWorktreeLaunch("/definitely/not/a/worktree", {
				GJC_LIFECYCLE_LAUNCH_ATTESTATION_FILE: "/tmp/gjc-launch-attestation.json",
			}),
		).rejects.toThrow("lifecycle_launch_attestation_binding_missing");
		await expect(
			attestWorktreeLaunch("/definitely/not/a/worktree", {
				GJC_LIFECYCLE_LAUNCH_ATTESTATION: "{not-json",
				GJC_LIFECYCLE_LAUNCH_ATTESTATION_FILE: "/tmp/gjc-launch-attestation.json",
			}),
		).rejects.toThrow("lifecycle_launch_attestation_binding_invalid");
	});
	it("attests a compiled executable's bytes and injected command argv", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-compiled-launch-attestation-"));
		try {
			const branch = "compiled-attestation";
			const init = Bun.spawnSync(["git", "init", `--initial-branch=${branch}`], {
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(init.exitCode).toBe(0);

			const executable = path.join(root, "gjc-compiled");
			const executableBytes = Buffer.from("#!/compiled-gjc\nattested-binary-bytes\n");
			await fs.writeFile(executable, executableBytes);
			const canonicalExecutable = await fs.realpath(executable);
			const executableDigest = crypto.createHash("sha256").update(executableBytes).digest("hex");
			const commandArgs = ["worktree", "create", "--branch", branch];
			const command = [canonicalExecutable, ...commandArgs];
			const commandDigest = crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
			expect(digestLifecycleLaunchCommand(command)).toBe(commandDigest);

			const attestationFile = path.join(root, "attestation.json");
			const binding = {
				launch_id: "launch-123",
				nonce: "nonce-123",
				child_token: "child-token-123",
				request_id: "request-123",
				session_id: "session-123",
				generation: "generation-123",
				run_id: "run-123",
				incarnation: "incarnation-123",
				command_sha256: commandDigest,
				expected_runtime_identity: { executable: canonicalExecutable, argv_sha256: commandDigest },
				expected_runtime_fingerprint: { mode: "compiled" as const, digest: executableDigest },
				attestation_file: attestationFile,
				deadline_ms: Date.now() + 30_000,
				requested_branch: branch,
			};
			const coordinatorEnv: NodeJS.ProcessEnv = {};
			await expect(
				attestWorktreeLaunch(
					root,
					{
						[LIFECYCLE_LAUNCH_ATTESTATION_ENV]: JSON.stringify(binding),
						[LIFECYCLE_LAUNCH_ATTESTATION_FILE_ENV]: attestationFile,
					},
					{ runtimeExecPath: executable, commandArgs, coordinatorEnv },
				),
			).resolves.toBeUndefined();

			const attestationBytes = await fs.readFile(attestationFile);
			const attestation = JSON.parse(attestationBytes.toString()) as {
				observed_runtime_identity: { executable: string; argv_sha256: string };
				observed_runtime_fingerprint: { mode: string; digest: string };
			};
			expect(attestation.observed_runtime_identity).toEqual({
				executable: canonicalExecutable,
				argv_sha256: commandDigest,
			});
			expect(attestation.observed_runtime_fingerprint).toEqual({ mode: "compiled", digest: executableDigest });
			expect(coordinatorEnv.GJC_COORDINATOR_SESSION_ATTESTATION_DIGEST).toBe(
				crypto.createHash("sha256").update(attestationBytes).digest("hex"),
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
