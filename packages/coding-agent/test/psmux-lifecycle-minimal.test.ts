import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonSpawnCreate } from "@gajae-code/coding-agent/sdk/bus/lifecycle-control-runtime";
import {
	isReviewedPsmuxLifecycleExecutable,
	PSMUX_LIFECYCLE_MARKER_ENV,
	PSMUX_LIFECYCLE_NAMESPACE,
	psmuxExactSessionTarget,
	psmuxLifecycleArgv,
	readPsmuxMarkerLine,
} from "@gajae-code/coding-agent/sdk/bus/psmux-lifecycle";

const marker = "A".repeat(43);

describe("minimal psmux lifecycle boundary", () => {
	it("accepts one requested show-environment marker while ignoring provider-owned lines", () => {
		expect(readPsmuxMarkerLine(`SHELL=/bin/sh\r\n${PSMUX_LIFECYCLE_MARKER_ENV}=${marker}\r\nTERM=screen`)).toBe(
			marker,
		);
	});

	it("rejects missing, duplicate, and malformed marker lines", () => {
		for (const output of [
			"SHELL=/bin/sh",
			`${PSMUX_LIFECYCLE_MARKER_ENV}=${marker}\n${PSMUX_LIFECYCLE_MARKER_ENV}=${marker}`,
			`${PSMUX_LIFECYCLE_MARKER_ENV}=not-a-marker`,
		])
			expect(readPsmuxMarkerLine(output)).toBeUndefined();
	});

	it("uses the lifecycle namespace and exact =name targets", () => {
		expect(psmuxLifecycleArgv("psmux.exe", ["list-sessions"])).toEqual([
			"psmux.exe",
			"-L",
			PSMUX_LIFECYCLE_NAMESPACE,
			"list-sessions",
		]);
		expect(psmuxExactSessionTarget("gjc_lc_sess_1")).toBe("=gjc_lc_sess_1");
		expect(() => psmuxExactSessionTarget("bad\nname")).toThrow("invalid_psmux_session_name");
	});

	it("refuses an unreviewed executable before inventory or session mutation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-psmux-lifecycle-"));
		const executable = path.join(root, "psmux");
		const target = process.cwd().replaceAll("\\", "/");
		fs.writeFileSync(executable, "not a reviewed psmux binary");
		const spawn = spyOn(Bun, "spawnSync");
		try {
			await expect(
				daemonSpawnCreate({
					GJC_TMUX_COMMAND: executable,
					GJC_PSMUX_COMMAND: executable,
				})(
					{
						type: "session_create",
						requestId: "request-1",
						lifecycleRequestId: "request-1",
						intendedSessionId: "session-1",
						updateId: 1,
						chatId: "1",
						token: "token",
						target: { kind: "existing_path", path: target },
					},
					{ lifecycleRequestId: "request-1", intendedSessionId: "session-1" },
				),
			).rejects.toThrow("gjc_lifecycle_psmux_attestation_refused");
			expect(spawn.mock.calls.flatMap(call => (Array.isArray(call[0]) ? [call[0]] : [])).flat()).not.toContain(
				"list-sessions",
			);
			expect(fs.existsSync(target)).toBe(true);
		} finally {
			spawn.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "win32" || !isReviewedPsmuxLifecycleExecutable("psmux"))(
		"keeps the installed reviewed psmux profile in the dedicated namespace",
		() =>
			expect(
				psmuxLifecycleArgv("psmux", ["show-environment", "-t", "=session", PSMUX_LIFECYCLE_MARKER_ENV]).slice(1, 3),
			).toEqual(["-L", PSMUX_LIFECYCLE_NAMESPACE]),
	);
});
