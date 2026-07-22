import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	fingerprintWorktreeRuntime,
	resolveGjcRuntimeArgv,
	resolveGjcRuntimeSpawnInfo,
} from "../../src/daemon/runtime";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("resolveGjcRuntimeArgv", () => {
	test("uses absolute source argv without inspecting the filesystem", () => {
		const resolved = resolveGjcRuntimeArgv("relative/bin/bun");
		expect(resolved.mode).toBe("source");
		expect(resolved.execPath).toMatch(/relative\/bin\/bun$/);
		expect(resolved.argsPrefix).toHaveLength(1);
		expect(resolved.argsPrefix[0]).toMatch(/packages\/coding-agent\/bin\/gjc\.js$/);
	});

	test("uses an absolute compiled executable directly", () => {
		expect(resolveGjcRuntimeArgv("./dist/gjc")).toEqual({
			execPath: `${process.cwd()}/dist/gjc`,
			mode: "compiled",
			argsPrefix: [],
		});
	});

	test("preserves the compatibility spawn contract", () => {
		const compiled = resolveGjcRuntimeSpawnInfo("/opt/gjc/gjc");
		expect(compiled.reloadPicksUpSourceEdits).toBeFalse();
		expect(compiled.warning).toContain("Rebuild");
	});
	test("detects compiled executable replacement at the same path", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-runtime-"));
		roots.push(root);
		const executable = path.join(root, "gjc");
		await fs.writeFile(executable, "first");
		const first = await fingerprintWorktreeRuntime({ execPath: executable });
		await fs.writeFile(executable, "second");
		const second = await fingerprintWorktreeRuntime({ execPath: executable });
		expect(second).not.toEqual(first);
	});
});
