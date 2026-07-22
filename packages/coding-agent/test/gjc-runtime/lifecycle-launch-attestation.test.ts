import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertLifecycleLaunchAttestation,
	digestLifecycleLaunchCommand,
	type LifecycleLaunchAttestation,
	type LifecycleLaunchAttestationExpectation,
	parseWorktreeLaunchBinding,
	projectLifecycleSourceManifestIdentity,
	type WorktreeLaunchBinding,
	waitForLifecycleLaunchAttestation,
	writeLifecycleLaunchAttestationExclusive,
} from "@gajae-code/coding-agent/gjc-runtime/lifecycle-launch-attestation";

const digest = crypto.createHash("sha256").update("command").digest("hex");
const fingerprintDigest = crypto.createHash("sha256").update("runtime").digest("hex");

function fixture(): LifecycleLaunchAttestation {
	return {
		schema_version: 1,
		launch_id: "launch-2681",
		nonce: "nonce-that-must-not-leak",
		request_id: "request-2681",
		session_id: "session-2681",
		generation: "generation-2681",
		run_id: "run-2681",
		incarnation: "incarnation-2681",
		child_token: "child-token-that-must-not-leak",
		command_sha256: digest,
		expected_runtime_identity: { executable: "/usr/bin/bun", argv_sha256: digest },
		observed_runtime_identity: { executable: "/usr/bin/bun", argv_sha256: digest },
		observed_runtime_fingerprint: { mode: "source", digest: fingerprintDigest },
		canonical_cwd: "/repo/worktree",
		git: { top_level: "/repo/worktree", common_dir: "/repo/.git", branch: "feature/2681" },
		source_manifest: {
			package_name: "@gajae-code/coding-agent",
			package_version: "1.0.0",
			package_relative_path: "src/cli.ts",
			resolver_anchor: "file:///repo/packages/coding-agent/src/cli.ts",
			manifest_sha256: digest,
		},
		created_at: "2026-07-22T00:00:00.000Z",
	};
}

function expectation(value: LifecycleLaunchAttestation): LifecycleLaunchAttestationExpectation {
	const { observed_runtime_identity: _observed, created_at: _created, schema_version: _schema, ...expected } = value;
	return expected;
}
function bindingFixture(): WorktreeLaunchBinding {
	return {
		launch_id: "launch-2681",
		nonce: "nonce-that-must-not-leak",
		child_token: "child-token-that-must-not-leak",
		request_id: "request-2681",
		session_id: "session-2681",
		generation: "generation-2681",
		run_id: "run-2681",
		incarnation: "incarnation-2681",
		command_sha256: digest,
		expected_runtime_identity: { executable: "/usr/bin/bun", argv_sha256: digest },
		expected_runtime_fingerprint: { mode: "source", digest: fingerprintDigest },
		attestation_file: "/tmp/gjc-launch-attestation.json",
		deadline_ms: Date.now() + 30_000,
		requested_branch: "feature/2681",
	};
}

describe("lifecycle launch attestation", () => {
	it("projects the canonical source manifest identity and command digest", () => {
		const command = ["/usr/bin/bun", "run", "src/cli.ts"];
		expect(digestLifecycleLaunchCommand(command)).toBe(
			crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"),
		);
		expect(
			projectLifecycleSourceManifestIdentity({
				digest,
				members: [
					{
						packageName: "@gajae-code/coding-agent",
						packageVersion: "1.0.0",
						packageRelativePath: "src/cli.ts",
						resolverAnchor: { specifier: "file:///repo/packages/coding-agent/src/cli.ts" },
					},
				],
			}),
		).toEqual(fixture().source_manifest);
	});
	it("durably creates and reads an exact matching attestation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-attestation-"));
		try {
			const value = fixture();
			const file = path.join(root, "binding-ref.json");
			await writeLifecycleLaunchAttestationExclusive(file, value);
			expect(
				await waitForLifecycleLaunchAttestation(file, expectation(value), { timeout_ms: 10, poll_ms: 1 }),
			).toEqual(value);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed for malformed, replayed, foreign, decoy, and mismatched attestations", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-attestation-"));
		try {
			const value = fixture();
			const expected = expectation(value);
			const target = path.join(root, "binding-ref.json");
			const decoy = path.join(root, "decoy.json");
			await fs.writeFile(target, "{not-json\n");
			await expect(
				waitForLifecycleLaunchAttestation(target, expected, { timeout_ms: 1, poll_ms: 1 }),
			).rejects.toThrow("lifecycle_launch_attestation_timeout");
			await fs.writeFile(target, `${JSON.stringify({ ...value, nonce: "replayed" })}\n`);
			await expect(
				waitForLifecycleLaunchAttestation(target, expected, { timeout_ms: 1, poll_ms: 1 }),
			).rejects.toThrow("lifecycle_launch_attestation_mismatch");
			await fs.writeFile(target, `${JSON.stringify({ ...value, session_id: "foreign" })}\n`);
			await expect(
				waitForLifecycleLaunchAttestation(target, expected, { timeout_ms: 1, poll_ms: 1 }),
			).rejects.toThrow("lifecycle_launch_attestation_mismatch");
			await fs.rm(target);
			await fs.writeFile(decoy, `${JSON.stringify(value)}\n`);
			await expect(
				waitForLifecycleLaunchAttestation(target, expected, { timeout_ms: 1, poll_ms: 1 }),
			).rejects.toThrow("lifecycle_launch_attestation_timeout");
			expect(() =>
				assertLifecycleLaunchAttestation({ ...value, git: { ...value.git, branch: "wrong" } }, expected),
			).toThrow("lifecycle_launch_attestation_mismatch");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("rejects an attestation whose observed runtime fingerprint differs from the expected child", () => {
		const value = fixture();
		const expected = expectation(value);
		expect(() =>
			assertLifecycleLaunchAttestation(
				{
					...value,
					observed_runtime_fingerprint: {
						...value.observed_runtime_fingerprint,
						digest: crypto.createHash("sha256").update("foreign source closure").digest("hex"),
					},
				},
				expected,
			),
		).toThrow("lifecycle_launch_attestation_mismatch");
	});
	it("accepts only exact top-level, git, and source manifest attestation schemas", () => {
		const value = fixture();
		const expected = expectation(value);
		expect(() => assertLifecycleLaunchAttestation(value, expected)).not.toThrow();

		const extensions: unknown[] = [
			{ ...value, unexpected: true },
			{ ...value, git: { ...value.git, unexpected: true } },
			{ ...value, source_manifest: { ...value.source_manifest, unexpected: true } },
		];
		for (const extension of extensions)
			expect(() => assertLifecycleLaunchAttestation(extension, expected)).toThrow(
				"lifecycle_launch_attestation_malformed",
			);
	});

	it("uses exclusive creation and redacts secrets from projections and errors", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-attestation-"));
		try {
			const value = fixture();
			const file = path.join(root, "binding-ref.json");
			await writeLifecycleLaunchAttestationExclusive(file, value);
			await expect(writeLifecycleLaunchAttestationExclusive(file, value)).rejects.toThrow(
				"lifecycle_launch_attestation_exclusive_create_failed",
			);
			const serializedError = String(
				await writeLifecycleLaunchAttestationExclusive(file, value).catch(error => error),
			);
			expect(serializedError).not.toContain(value.nonce);
			expect(serializedError).not.toContain(value.child_token);
			expect(serializedError).not.toContain(value.command_sha256);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("strictly parses only complete, current worktree launch bindings", () => {
		const binding = bindingFixture();
		expect(parseWorktreeLaunchBinding(JSON.stringify(binding))).toEqual(binding);

		const invalid = [
			"{not-json",
			JSON.stringify({ launch_id: binding.launch_id }),
			JSON.stringify({ ...binding, unexpected: true }),
			JSON.stringify({ ...binding, deadline_ms: 0 }),
			JSON.stringify({ ...binding, attestation_file: "relative.json" }),
			JSON.stringify({ ...binding, launch_id: "" }),
			JSON.stringify({ ...binding, requested_branch: "" }),
			JSON.stringify({ ...binding, command_sha256: "not-a-digest" }),
			JSON.stringify({
				...binding,
				expected_runtime_identity: { ...binding.expected_runtime_identity, extra: true },
			}),
			JSON.stringify({ ...binding, expected_runtime_fingerprint: { mode: "invalid", digest: fingerprintDigest } }),
		];
		for (const raw of invalid)
			expect(() => parseWorktreeLaunchBinding(raw)).toThrow("lifecycle_launch_attestation_binding_invalid");
	});
});
