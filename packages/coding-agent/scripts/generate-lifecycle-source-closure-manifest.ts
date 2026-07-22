#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalSourceClosureLocator,
	digestLifecycleSourceClosureMembers,
	LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBER_BYTES,
	LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBERS,
	LIFECYCLE_SOURCE_CLOSURE_MAX_TOTAL_BYTES,
	LIFECYCLE_SOURCE_CLOSURE_SCHEMA_VERSION,
	type LifecycleSourceClosureManifest,
	type LifecycleSourceClosureMember,
	type SourceClosureLocator,
	type SourceClosureResolverAnchor,
	sourceClosureLocator,
} from "../src/gjc-runtime/lifecycle-source-closure";
import { buildDevCompileArgs, compiledExternalPackages } from "./compile-args";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const packageDir = path.join(repoRoot, "packages", "coding-agent");
const packagesDir = path.join(repoRoot, "packages");
const manifestPath = path.join(packageDir, "src", "daemon", "lifecycle-source-closure.generated.json");
const nodeBuiltins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const lifecycleSourceClosureRoots = ["./src/cli.ts"] as const;

type PackageIdentity = { packageName: string; packageVersion: string };
type Locator = SourceClosureLocator;
type ResolverAnchor = SourceClosureResolverAnchor;
type SourceClosureMember = LifecycleSourceClosureMember;
type SourceClosureManifest = LifecycleSourceClosureManifest;
type BunImport = { path?: unknown; original?: unknown };
type BunInput = { imports?: BunImport[] };
type BunMetafile = { inputs?: Record<string, BunInput> };
type SourceMember = { filePath: string; locator: Locator; imports: { filePath: string; specifier: string }[] };
export type LifecycleSourceClosureGeneratorOptions = {
	metafile: BunMetafile;
	packageDir: string;
	packagesDir: string;
	manifestPath: string;
	lockedSourceExternalPackages: ReadonlySet<string>;
	compiledExternalPackages: readonly string[];
	runtimeRoots: readonly string[];
	readFile: (filePath: string) => Promise<Uint8Array>;
	resolveImport: (specifier: string, from: string) => string;
	nodeBuiltins?: ReadonlySet<string>;
};

export async function generateLifecycleSourceClosureManifest(
	options: LifecycleSourceClosureGeneratorOptions,
): Promise<SourceClosureManifest> {
	const {
		metafile,
		packageDir,
		packagesDir,
		manifestPath,
		lockedSourceExternalPackages,
		compiledExternalPackages,
		runtimeRoots,
		readFile: readSourceFile,
		resolveImport,
		nodeBuiltins: injectedNodeBuiltins = nodeBuiltins,
	} = options;
	const sourcePathForGraph = (input: string, baseDir = packageDir): string | null => {
		const candidate = path.resolve(baseDir, input);
		if (!isContained(packagesDir, candidate)) return null;
		return candidate;
	};
	const isReviewedExternalPathForGraph = (candidate: string): boolean => {
		const packageName = reviewedExternalPackage(candidate);
		return (
			packageName !== undefined &&
			(compiledExternalPackages.includes(packageName) || lockedSourceExternalPackages.has(packageName))
		);
	};
	if (typeof metafile.inputs !== "object" || metafile.inputs === null || Array.isArray(metafile.inputs))
		fail("Bun compile metafile has no inputs record");

	const packageCache = new Map<string, { root: string; identity: PackageIdentity }>();
	async function packageFor(filePath: string): Promise<{ root: string; identity: PackageIdentity }> {
		for (
			let candidate = path.dirname(filePath);
			candidate !== packagesDir && isContained(packagesDir, candidate);
			candidate = path.dirname(candidate)
		) {
			const cached = packageCache.get(candidate);
			if (cached) return cached;
			let packageJson: Uint8Array;
			try {
				packageJson = await readSourceFile(path.join(candidate, "package.json"));
			} catch (error) {
				if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			const identity = parsePackageIdentity(JSON.parse(new TextDecoder().decode(packageJson)));
			const found = { root: candidate, identity };
			packageCache.set(candidate, found);
			return found;
		}
		fail(`source member has no package identity: ${filePath}`);
	}

	const rawInputs = new Map<string, BunInput>();
	for (const [input, metadata] of Object.entries(metafile.inputs)) {
		if (typeof input !== "string" || !isRecord(metadata)) fail("Bun compile metafile has malformed input evidence");
		const resolvedInput = path.resolve(packageDir, input);
		const filePath = sourcePathForGraph(input);
		if (filePath === null) {
			if (isReviewedExternalPathForGraph(resolvedInput)) continue;
			fail(`Bun compile metafile input has no reviewed package owner: ${input}`);
		}
		if (filePath === manifestPath) continue;
		rawInputs.set(filePath, metadata);
	}
	if (rawInputs.size === 0) fail("Bun compile metafile resolved no package-owned source members");
	if (rawInputs.size > LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBERS)
		fail(`member cap exceeded (${LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBERS})`);

	const sourceMembers = new Map<string, SourceMember>();
	let totalBytes = 0;
	for (const filePath of [...rawInputs.keys()].sort()) {
		const packageInfo = await packageFor(filePath);
		const packageRelativePath = path.relative(packageInfo.root, filePath).replaceAll("\\", "/");
		if (
			packageRelativePath.length === 0 ||
			packageRelativePath.split("/").some(part => part === "" || part === "." || part === "..")
		)
			fail("source member has invalid package-relative path");
		const bytes = await readSourceFile(filePath);
		if (bytes.byteLength > LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBER_BYTES)
			fail(`member byte cap exceeded: ${packageRelativePath}`);
		totalBytes += bytes.byteLength;
		if (totalBytes > LIFECYCLE_SOURCE_CLOSURE_MAX_TOTAL_BYTES)
			fail(`total byte cap exceeded (${LIFECYCLE_SOURCE_CLOSURE_MAX_TOTAL_BYTES})`);
		sourceMembers.set(filePath, {
			filePath,
			locator: sourceClosureLocator(packageInfo.identity, packageRelativePath),
			imports: [],
		});
	}
	for (const [filePath, metadata] of rawInputs) {
		const member = sourceMembers.get(filePath)!;
		if (metadata.imports !== undefined && !Array.isArray(metadata.imports)) {
			fail(`Bun compile metafile imports are malformed: ${filePath}`);
		}
		for (const imported of metadata.imports ?? []) {
			if (!isRecord(imported) || typeof imported.path !== "string") {
				fail(`Bun compile metafile import evidence is malformed: ${filePath}`);
			}
			const specifier = typeof imported.original === "string" ? imported.original : imported.path;
			if (specifier === "bun" || specifier.startsWith("bun:") || injectedNodeBuiltins.has(specifier)) continue;
			let target: string;
			try {
				target = path.resolve(resolveImport(specifier, path.dirname(filePath)));
			} catch {
				fail(`Bun compile metafile import target is unresolved: ${specifier}`);
			}
			if (target === manifestPath) continue;
			if (!sourceMembers.has(target)) {
				if (sourcePathForGraph(target) === null) {
					if (isReviewedExternalPathForGraph(target)) continue;
					fail(`Bun compile metafile edge has no reviewed package owner: ${specifier}`);
				}
				fail(`Bun compile metafile omitted resolved package source: ${specifier}`);
			}
			member.imports.push({ filePath: target, specifier });
		}
		member.imports.sort((left, right) =>
			`${left.filePath}\0${left.specifier}`.localeCompare(`${right.filePath}\0${right.specifier}`),
		);
	}

	const assigned = new Map<string, ResolverAnchor>();
	for (const entrypoint of runtimeRoots) {
		const filePath = sourcePathForGraph(entrypoint);
		if (filePath === null || !sourceMembers.has(filePath))
			fail(`Bun compile metafile omitted lifecycle root: ${entrypoint}`);
		const specifier = path
			.relative(path.dirname(path.join(packageDir, "src", "gjc-runtime", "lifecycle-source-closure.ts")), filePath)
			.replaceAll("\\", "/");
		assigned.set(filePath, {
			kind: "root",
			specifier: specifier.startsWith(".") ? specifier : `./${specifier}`,
		});
	}
	while (assigned.size < sourceMembers.size) {
		let progressed = false;
		for (const member of [...sourceMembers.values()].sort((left, right) =>
			left.filePath.localeCompare(right.filePath),
		)) {
			if (assigned.has(member.filePath)) continue;
			for (const importer of [...sourceMembers.values()].sort((left, right) =>
				left.filePath.localeCompare(right.filePath),
			)) {
				const edge = importer.imports.find(candidate => candidate.filePath === member.filePath);
				if (!edge || !assigned.has(importer.filePath)) continue;
				assigned.set(member.filePath, { kind: "member", importer: importer.locator, specifier: edge.specifier });
				progressed = true;
				break;
			}
		}
		if (!progressed)
			fail(`source graph has ${sourceMembers.size - assigned.size} members without a runtime resolver anchor`);
	}

	const members = [...assigned.entries()].map(([filePath, resolverAnchor]) => {
		const member = sourceMembers.get(filePath)!;
		return { ...member.locator, resolverAnchor, byteLength: 0, byteDigest: "", filePath };
	});
	const ordered: SourceClosureMember[] = [];
	const remaining = new Map(members.map(member => [member.filePath, member]));
	while (remaining.size > 0) {
		let progressed = false;
		for (const [filePath, member] of [...remaining.entries()].sort(([left], [right]) => left.localeCompare(right))) {
			const anchor = member.resolverAnchor;
			if (
				anchor.kind === "member" &&
				!ordered.some(
					candidate => canonicalSourceClosureLocator(candidate) === canonicalSourceClosureLocator(anchor.importer),
				)
			)
				continue;
			const bytes = await readSourceFile(filePath);
			const { filePath: _, ...entry } = member;
			ordered.push({ ...entry, byteLength: bytes.byteLength, byteDigest: sha256(bytes) });
			remaining.delete(filePath);
			progressed = true;
		}
		if (!progressed) fail("source graph contains a resolver-anchor cycle");
	}
	return {
		schemaVersion: LIFECYCLE_SOURCE_CLOSURE_SCHEMA_VERSION,
		members: ordered,
		digest: digestLifecycleSourceClosureMembers(ordered),
	};
}
const lockfileValue: unknown = Bun.JSON5.parse(await readFile(path.join(repoRoot, "bun.lock"), "utf8"));
if (!isRecord(lockfileValue) || !isRecord(lockfileValue.packages)) {
	throw new Error("Lifecycle source closure: bun.lock has no packages authority");
}
const lockedSourceExternalPackages = new Set(Object.keys(lockfileValue.packages));

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fail(message: string): never {
	throw new Error(`Lifecycle source closure: ${message}`);
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function reviewedExternalPackage(candidate: string): string | undefined {
	const parts = path.resolve(candidate).split(path.sep);
	const nodeModules = parts.lastIndexOf("node_modules");
	if (nodeModules < 0 || nodeModules + 1 >= parts.length) return undefined;
	const first = parts[nodeModules + 1]!;
	return first.startsWith("@") && nodeModules + 2 < parts.length ? `${first}/${parts[nodeModules + 2]!}` : first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parsePackageIdentity(value: unknown): PackageIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("package.json is invalid");
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || record.name.length === 0) fail("package.json has no package name");
	if (typeof record.version !== "string" || record.version.length === 0) fail("package.json has no package version");
	return { packageName: record.name, packageVersion: record.version };
}

async function compileMetafile(tempDir: string): Promise<BunMetafile> {
	const outputPath = path.join(tempDir, "gjc");
	const metafilePath = path.join(tempDir, "metafile.json");
	const command = [
		...buildDevCompileArgs(outputPath, undefined, lifecycleSourceClosureRoots),
		`--metafile=${metafilePath}`,
	];
	const proc = Bun.spawn(command, { cwd: packageDir, stdout: "pipe", stderr: "pipe" });
	if ((await proc.exited) !== 0) {
		const stderr = (await new Response(proc.stderr).text()).trim();
		fail(`Bun compile metafile command failed${stderr ? `: ${stderr.slice(0, 512)}` : ""}`);
	}
	try {
		return JSON.parse(await readFile(metafilePath, "utf8")) as BunMetafile;
	} catch {
		fail("Bun compile metafile was missing or invalid JSON");
	}
}

async function generateManifest(): Promise<SourceClosureManifest> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "gjc-source-closure-"));
	try {
		return await generateLifecycleSourceClosureManifest({
			metafile: await compileMetafile(tempDir),
			packageDir,
			packagesDir,
			manifestPath,
			lockedSourceExternalPackages,
			compiledExternalPackages,
			runtimeRoots: lifecycleSourceClosureRoots,
			readFile: filePath => readFile(filePath),
			resolveImport: (specifier, from) => Bun.resolveSync(specifier, from),
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.some(arg => arg !== "--check")) fail("only --check is supported");
	const expected = await generateManifest();
	if (args.includes("--check")) {
		let actual: unknown;
		try {
			actual = JSON.parse(await readFile(manifestPath, "utf8"));
		} catch {
			fail("generated manifest is missing or invalid JSON");
		}
		if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("generated manifest is stale");
		return;
	}
	await writeFile(manifestPath, `${JSON.stringify(expected, null, "\t")}\n`);
}

if (import.meta.main) await main();
