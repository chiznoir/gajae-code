#!/usr/bin/env bun

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import manifest from "../src/daemon/lifecycle-source-closure.generated.json";

interface SourceClosureMember {
	packageName: string;
	packageVersion: string;
	packageRelativePath: string;
	byteLength: number;
	byteDigest: string;
}

interface SourceClosureManifest {
	members: SourceClosureMember[];
}

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const codingAgentName = "@gajae-code/coding-agent";
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");
const wrapperName = "gajae-code";
const linuxX64Name = "@gajae-code/natives-linux-x64";

function run(command: string[], cwd: string): string {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed:\n${new TextDecoder().decode(result.stderr).trim()}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

function packedTarballPath(output: string, destination: string): string {
	const packed = JSON.parse(output) as { filename?: unknown }[];
	const filename = packed[0]?.filename;
	if (typeof filename !== "string" || filename.length === 0) throw new Error("npm pack produced no tarball filename");
	return path.join(destination, filename);
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function packageRoots(): Promise<Map<string, string>> {
	const roots = new Map<string, string>();
	for await (const relative of new Bun.Glob("packages/**/package.json").scan({ cwd: repoRoot, onlyFiles: true })) {
		const file = Bun.file(path.join(repoRoot, relative));
		const value = (await file.json()) as { name?: unknown };
		if (typeof value.name !== "string" || !value.name) continue;
		if (roots.has(value.name)) throw new Error(`duplicate package root: ${value.name}`);
		roots.set(value.name, path.dirname(file.name!));
	}
	return roots;
}

async function assertPackageIdentity(root: string, member: SourceClosureMember): Promise<void> {
	const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
		name?: unknown;
		version?: unknown;
	};
	if (packageJson.name !== member.packageName || packageJson.version !== member.packageVersion) {
		throw new Error(`installed package identity mismatch: ${member.packageName}`);
	}
}
async function stagePackage(sourceDir: string, stagingRoot: string, packageName: string): Promise<string> {
	const stagedDir = path.join(stagingRoot, packageName.replaceAll("/", "__"));
	await fs.cp(sourceDir, stagedDir, { recursive: true });
	return stagedDir;
}

function pack(stagedDir: string, destination: string): string {
	return packedTarballPath(
		run(["npm", "pack", "--ignore-scripts", "--pack-destination", destination, "--json"], stagedDir),
		destination,
	);
}

async function writeFingerprintProbe(tempDir: string, installedCodingAgentDir: string): Promise<string> {
	const probePath = path.join(tempDir, "fingerprint-probe.ts");
	const runtimePath = path.join(installedCodingAgentDir, "src", "daemon", "runtime.ts");
	await fs.writeFile(
		probePath,
		`import { spawnSync } from "node:child_process";
import { fingerprintWorktreeRuntime } from ${JSON.stringify(runtimePath)};
const first = await fingerprintWorktreeRuntime();
const second = await fingerprintWorktreeRuntime();
if (first.mode !== "source" || first.digest !== second.digest) throw new Error("installed parent fingerprint is unstable");
const child = spawnSync(process.execPath, ["-e", ${JSON.stringify(`import { fingerprintWorktreeRuntime } from ${JSON.stringify(runtimePath)}; process.stdout.write(JSON.stringify(await fingerprintWorktreeRuntime()));`)}], { cwd: process.cwd(), encoding: "utf8" });
if (child.status !== 0) throw new Error("installed child fingerprint failed: " + child.stderr);
const childFingerprint = JSON.parse(child.stdout) as { mode?: unknown; digest?: unknown };
if (childFingerprint.mode !== first.mode || childFingerprint.digest !== first.digest) throw new Error("installed parent/child fingerprint mismatch");
process.stdout.write(JSON.stringify(first));
`,
	);
	return probePath;
}

async function main(): Promise<void> {
	const sourceManifest = manifest as SourceClosureManifest;
	const roots = await packageRoots();
	const membersByPackage = Map.groupBy(sourceManifest.members, member => member.packageName);
	if (!membersByPackage.has(codingAgentName)) throw new Error("coding-agent closure is missing");

	const ownerNames = [...membersByPackage.keys()];
	for (const packageName of ownerNames) {
		if (!roots.has(packageName)) throw new Error(`missing package root: ${packageName}`);
	}
	const wrapperDir = roots.get(wrapperName);
	const nativesDir = roots.get("@gajae-code/natives");
	const linuxX64Dir = roots.get(linuxX64Name);
	if (!wrapperDir || !nativesDir || !linuxX64Dir) throw new Error("missing package smoke dependency root");

	const repoGeneratedManifestPath = path.join(
		codingAgentDir,
		"src",
		"daemon",
		"lifecycle-source-closure.generated.json",
	);
	const repoGeneratedManifestBefore = await fs.readFile(repoGeneratedManifestPath);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lifecycle-source-closure-package-"));
	let repositoryManifestMutated = false;
	try {
		const stagedPackagesDir = path.join(tempDir, "packages");
		await fs.mkdir(stagedPackagesDir, { recursive: true });
		const stagedRoots = new Map<string, string>();
		for (const packageName of new Set([...ownerNames, wrapperName])) {
			stagedRoots.set(packageName, await stagePackage(roots.get(packageName)!, stagedPackagesDir, packageName));
		}
		const stagedLinuxX64Dir = await stagePackage(linuxX64Dir, stagedPackagesDir, linuxX64Name);
		const stagedNativeDir = path.join(stagedLinuxX64Dir, "native");
		await fs.mkdir(stagedNativeDir, { recursive: true });
		for (const entry of await fs.readdir(path.join(nativesDir, "native"))) {
			if (entry.startsWith("pi_natives.linux-x64") && entry.endsWith(".node")) {
				await fs.copyFile(path.join(nativesDir, "native", entry), path.join(stagedNativeDir, entry));
			}
		}

		const tarballs = new Map<string, string>();
		for (const [packageName, stagedDir] of stagedRoots) {
			tarballs.set(packageName, pack(stagedDir, tempDir));
		}
		tarballs.set(linuxX64Name, pack(stagedLinuxX64Dir, tempDir));

		const dependencies = Object.fromEntries(
			[...tarballs].map(([packageName, tarball]) => [packageName, `file:${tarball}`]),
		);
		const workspaceManifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
			workspaces?: { catalog?: Record<string, string> };
		};
		await fs.writeFile(
			path.join(tempDir, "package.json"),
			`${JSON.stringify(
				{
					name: "lifecycle-source-closure-package-smoke",
					version: "0.0.0",
					private: true,
					workspaces: {
						catalog: { ...workspaceManifest.workspaces?.catalog, ...dependencies },
					},
					dependencies,
				},
				null,
				2,
			)}\n`,
		);
		const installedCodingAgentDir = path.join(tempDir, "node_modules", codingAgentName);
		run(["bun", "install", "--ignore-scripts", "--network-concurrency=0"], tempDir);
		const installedWrapper = JSON.parse(
			await fs.readFile(path.join(tempDir, "node_modules", wrapperName, "package.json"), "utf8"),
		) as { name?: unknown };
		if (installedWrapper.name !== wrapperName) throw new Error("installed wrapper package identity mismatch");

		const installedRoots = new Map<string, string>();
		for (const packageName of ownerNames) {
			const sourceRoot = roots.get(packageName)!;
			const installedRoot = isContained(codingAgentDir, sourceRoot)
				? path.join(installedCodingAgentDir, path.relative(codingAgentDir, sourceRoot))
				: path.join(tempDir, "node_modules", packageName);
			if (!isContained(path.join(tempDir, "node_modules"), installedRoot)) {
				throw new Error(`installed package root escaped node_modules: ${packageName}`);
			}
			installedRoots.set(packageName, installedRoot);
			await assertPackageIdentity(installedRoot, membersByPackage.get(packageName)![0]!);
		}
		for (const member of sourceManifest.members) {
			const memberPath = path.join(installedRoots.get(member.packageName)!, member.packageRelativePath);
			if (!isContained(installedRoots.get(member.packageName)!, memberPath)) {
				throw new Error(`installed closure member escaped package root: ${member.packageName}`);
			}
			const stat = await fs.stat(memberPath);
			if (!stat.isFile())
				throw new Error(
					`installed closure member is not a file: ${member.packageName}/${member.packageRelativePath}`,
				);
			const bytes = await fs.readFile(memberPath);
			if (
				bytes.byteLength !== member.byteLength ||
				crypto.createHash("sha256").update(bytes).digest("hex") !== member.byteDigest
			) {
				throw new Error(
					`installed closure member content differs: ${member.packageName}/${member.packageRelativePath}`,
				);
			}
		}

		const probePath = await writeFingerprintProbe(tempDir, installedCodingAgentDir);
		const baseline = JSON.parse(run(["bun", "run", probePath], tempDir)) as { mode?: unknown; digest?: unknown };
		if (baseline.mode !== "source" || typeof baseline.digest !== "string") {
			throw new Error("installed source fingerprint probe returned an invalid result");
		}

		if (process.platform === "linux" && process.arch === "x64") {
			run(["bun", path.join(tempDir, "node_modules", ".bin", "gjc"), "--smoke-test"], tempDir);
		}

		const mutation = sourceManifest.members.find(member => member.packageName !== codingAgentName);
		if (!mutation) throw new Error("closure has no installed source dependency to mutate");
		const mutationPath = path.join(installedRoots.get(mutation.packageName)!, mutation.packageRelativePath);
		const original = await fs.readFile(mutationPath);
		await fs.writeFile(mutationPath, Buffer.concat([original, Buffer.from("\n")]));
		const mismatch = Bun.spawnSync(["bun", "run", probePath], { cwd: tempDir, stdout: "pipe", stderr: "pipe" });
		if (mismatch.exitCode === 0) throw new Error("installed source mutation did not invalidate fingerprint");
		const mismatchOutput = `${new TextDecoder().decode(mismatch.stdout)}\n${new TextDecoder().decode(mismatch.stderr)}`;
		if (!mismatchOutput.includes("Lifecycle source closure member digest mismatch")) {
			throw new Error(`installed source mutation failed unexpectedly: ${mismatchOutput.slice(0, 512)}`);
		}

		process.stdout.write(
			`Lifecycle source closure package smoke passed (${sourceManifest.members.length} members, ${ownerNames.length} owners).\n`,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
		const repoGeneratedManifestAfter = await fs.readFile(repoGeneratedManifestPath);
		repositoryManifestMutated = !repoGeneratedManifestAfter.equals(repoGeneratedManifestBefore);
	}
	if (repositoryManifestMutated) {
		throw new Error("package smoke mutated the repository generated lifecycle source closure manifest");
	}
}

await main();
