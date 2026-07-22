import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	digestLifecycleSourceClosureMembers,
	LIFECYCLE_SOURCE_CLOSURE_SCHEMA_VERSION,
	type LifecycleSourceClosureManifest,
	materializeLifecycleSourceClosure,
	parseLifecycleSourceClosureManifest,
	type SourceClosureFileSystem,
} from "../../src/gjc-runtime/lifecycle-source-closure";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function packageFixture(
	name: string,
	version: string,
	relativePath: string,
	contents: string,
): Promise<{ root: string; file: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-source-closure-"));
	roots.push(root);
	const file = path.join(root, relativePath);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name, version }));
	await fs.writeFile(file, contents);
	return { root, file };
}

function fixtureIo(resolutions: Map<string, string>): SourceClosureFileSystem {
	return {
		async resolveImport(specifier, fromFile) {
			const result = resolutions.get(`${fromFile}\0${specifier}`);
			if (!result) throw new Error("unrecorded resolver anchor");
			return result;
		},
		async realpath(file) {
			return await fs.realpath(file);
		},
		async readFile(file) {
			return await fs.readFile(file);
		},
		async readPackageJson(file) {
			const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad metadata");
			const metadata = parsed as { name?: unknown; version?: unknown };
			if (typeof metadata.name !== "string" || typeof metadata.version !== "string") throw new Error("bad metadata");
			return { name: metadata.name, version: metadata.version };
		},
	};
}

function manifest(
	name: string,
	version: string,
	relativePath: string,
	contents: string,
): LifecycleSourceClosureManifest {
	const member = {
		packageName: name,
		packageVersion: version,
		packageRelativePath: relativePath,
		resolverAnchor: { kind: "root" as const, specifier: "./entry" },
		byteLength: Buffer.byteLength(contents),
		byteDigest: crypto.createHash("sha256").update(contents).digest("hex"),
	};
	return {
		schemaVersion: LIFECYCLE_SOURCE_CLOSURE_SCHEMA_VERSION,
		members: [member],
		digest: digestLifecycleSourceClosureMembers([member]),
	};
}

describe("lifecycle source closure", () => {
	test("materializes the same logical closure from checkout-like and independent package roots", async () => {
		const relative = "src/entry.ts";
		const contents = "export const value = 1;\n";
		const checkout = await packageFixture("@scope/example", "1.2.3", relative, contents);
		const installed = await packageFixture("@scope/example", "1.2.3", relative, contents);
		const rootAnchor = "/runtime/root.ts";
		const input = manifest("@scope/example", "1.2.3", relative, contents);
		const checkoutClosure = await materializeLifecycleSourceClosure(
			input,
			fixtureIo(new Map([[`${rootAnchor}\0./entry`, checkout.file]])),
			rootAnchor,
		);
		const installedClosure = await materializeLifecycleSourceClosure(
			input,
			fixtureIo(new Map([[`${rootAnchor}\0./entry`, installed.file]])),
			rootAnchor,
		);
		expect(checkoutClosure.digest).toBe(installedClosure.digest);
		expect(checkoutClosure.members[0].filePath).not.toBe(installedClosure.members[0].filePath);
		expect(checkoutClosure.members[0].locator).toEqual({
			packageName: "@scope/example",
			packageVersion: "1.2.3",
			packageRelativePath: relative,
		});
	});
	test("rejects unknown keys, NUL delimiters, and non-POSIX relative paths", () => {
		const good = manifest("example", "1", "src/a.ts", "a");
		const member = good.members[0];
		const invalidInputs: unknown[] = [
			{ ...good, unexpected: true },
			{ ...good, members: [{ ...member, unexpected: true }] },
			{ ...good, members: [{ ...member, resolverAnchor: { ...member.resolverAnchor, unexpected: true } }] },
			{
				...good,
				members: [
					{
						...member,
						resolverAnchor: {
							kind: "member",
							importer: {
								packageName: member.packageName,
								packageVersion: member.packageVersion,
								packageRelativePath: member.packageRelativePath,
								unexpected: true,
							},
							specifier: "./entry",
						},
					},
				],
			},
			{ ...good, members: [{ ...member, packageName: "example\0other" }] },
			{ ...good, members: [{ ...member, packageVersion: "1\0other" }] },
			{ ...good, members: [{ ...member, packageRelativePath: "src\0/a.ts" }] },
			{
				...good,
				members: [{ ...member, resolverAnchor: { kind: "root", specifier: "./entry\0other" } }],
			},
			{ ...good, members: [{ ...member, packageRelativePath: "src\\a.ts" }] },
		];
		for (const input of invalidInputs) expect(() => parseLifecycleSourceClosureManifest(input)).toThrow();
	});

	test("rejects malformed, traversal, duplicate, and missing anchor members", () => {
		const good = manifest("example", "1", "src/a.ts", "a");
		expect(() => parseLifecycleSourceClosureManifest({ schemaVersion: 1, members: [] })).toThrow();
		expect(() =>
			parseLifecycleSourceClosureManifest({
				...good,
				members: [{ ...good.members[0], packageRelativePath: "../escape.ts" }],
			}),
		).toThrow();
		expect(() =>
			parseLifecycleSourceClosureManifest({ ...good, members: [good.members[0], good.members[0]] }),
		).toThrow();
		expect(() =>
			parseLifecycleSourceClosureManifest({
				...good,
				members: [
					{
						...good.members[0],
						resolverAnchor: {
							kind: "member",
							importer: { packageName: "none", packageVersion: "1", packageRelativePath: "a.ts" },
							specifier: "./x",
						},
					},
				],
			}),
		).toThrow();
	});
	test("fails closed when package discovery finds duplicate matching roots", async () => {
		const contents = "export const value = 1;\n";
		const fixture = await packageFixture("example", "1", "src/entry.ts", contents);
		await fs.writeFile(
			path.join(fixture.root, "src/package.json"),
			JSON.stringify({ name: "example", version: "1" }),
		);
		const rootAnchor = "/runtime/root.ts";
		const input = manifest("example", "1", "entry.ts", contents);
		await expect(
			materializeLifecycleSourceClosure(
				input,
				fixtureIo(new Map([[`${rootAnchor}\0./entry`, fixture.file]])),
				rootAnchor,
			),
		).rejects.toThrow("resolution mismatch");
	});

	test("fails closed on package version, missing file, replacement, and symlink escape", async () => {
		const relative = "src/entry.ts";
		const fixture = await packageFixture("example", "1", relative, "original");
		const rootAnchor = "/runtime/root.ts";
		const input = manifest("example", "1", relative, "original");
		const io = fixtureIo(new Map([[`${rootAnchor}\0./entry`, fixture.file]]));
		await fs.writeFile(fixture.file, "replacement");
		await expect(materializeLifecycleSourceClosure(input, io, rootAnchor)).rejects.toThrow("digest mismatch");
		await fs.writeFile(fixture.file, "original");
		await fs.writeFile(path.join(fixture.root, "package.json"), JSON.stringify({ name: "example", version: "2" }));
		await expect(materializeLifecycleSourceClosure(input, io, rootAnchor)).rejects.toThrow("resolution mismatch");
		await fs.writeFile(path.join(fixture.root, "package.json"), JSON.stringify({ name: "example", version: "1" }));
		await fs.rm(fixture.file);
		await expect(materializeLifecycleSourceClosure(input, io, rootAnchor)).rejects.toThrow();
		const outside = await packageFixture("outside", "1", "entry.ts", "original");
		await fs.symlink(outside.file, fixture.file);
		await expect(materializeLifecycleSourceClosure(input, io, rootAnchor)).rejects.toThrow("escapes package root");
	});
});
