import { expect, it } from "bun:test";
import * as path from "node:path";
import { generateLifecycleSourceClosureManifest } from "../../scripts/generate-lifecycle-source-closure-manifest";

const repoRoot = "/fixture";
const packageDir = path.join(repoRoot, "packages", "coding-agent");
const packagesDir = path.join(repoRoot, "packages");
const root = path.join(packageDir, "src", "cli.ts");
type MetafileInput = { imports?: { path?: unknown; original?: unknown }[] };
const unrelatedRoot = path.join(packageDir, "src", "unrelated-worker.ts");

function options(inputs: Record<string, MetafileInput>) {
	const files = new Map<string, Uint8Array>([
		[
			path.join(packageDir, "package.json"),
			new TextEncoder().encode('{"name":"@fixture/coding-agent","version":"1.0.0"}'),
		],
		[root, new TextEncoder().encode("export {}\n")],
		[unrelatedRoot, new TextEncoder().encode("export {}\n")],
	]);
	return {
		metafile: { inputs },
		packageDir,
		packagesDir,
		manifestPath: path.join(packageDir, "src", "daemon", "lifecycle-source-closure.generated.json"),
		lockedSourceExternalPackages: new Set<string>(),
		compiledExternalPackages: [],
		runtimeRoots: ["src/cli.ts"],
		readFile: async (filePath: string): Promise<Uint8Array> => {
			const file = files.get(filePath);
			if (file === undefined) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
			return file;
		},
		resolveImport: (specifier: string): string => {
			if (specifier === "./missing") throw new Error("unresolved fixture");
			return path.join(packageDir, "src", "missing.ts");
		},
	};
}

it("rejects unowned input evidence", async () => {
	await expect(generateLifecycleSourceClosureManifest(options({ "../../unowned.ts": {} }))).rejects.toThrow(
		"input has no reviewed package owner",
	);
});

it("rejects unresolved graph edges", async () => {
	await expect(
		generateLifecycleSourceClosureManifest(options({ "src/cli.ts": { imports: [{ path: "./missing" }] } })),
	).rejects.toThrow("import target is unresolved: ./missing");
});

it("rejects graph evidence over the member cap", async () => {
	const inputs: Record<string, MetafileInput> = {};
	for (let index = 0; index <= 10_000; index++) inputs[`src/member-${index}.ts`] = {};
	await expect(generateLifecycleSourceClosureManifest(options(inputs))).rejects.toThrow("member cap exceeded");
});
it("rejects members reachable only from unrelated compile entrypoints", async () => {
	await expect(
		generateLifecycleSourceClosureManifest(
			options({
				"src/cli.ts": {},
				"src/unrelated-worker.ts": {},
			}),
		),
	).rejects.toThrow("members without a runtime resolver anchor");
});
