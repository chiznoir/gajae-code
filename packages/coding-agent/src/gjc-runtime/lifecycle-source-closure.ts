import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const LIFECYCLE_SOURCE_CLOSURE_SCHEMA_VERSION = 1;
export const LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBERS = 10_000;
export const LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBER_BYTES = 25 * 1024 * 1024;
export const LIFECYCLE_SOURCE_CLOSURE_MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_PACKAGE_ANCESTORS = 32;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export interface SourceClosurePackageIdentity {
	packageName: string;
	packageVersion: string;
}

export function sourceClosureLocator(
	identity: SourceClosurePackageIdentity,
	packageRelativePath: string,
): SourceClosureLocator {
	requiredDelimiterString(identity.packageName, "packageName");
	requiredDelimiterString(identity.packageVersion, "packageVersion");
	validateRelativePath(packageRelativePath);
	return { ...identity, packageRelativePath };
}

export interface SourceClosureLocator extends SourceClosurePackageIdentity {
	packageRelativePath: string;
}

export type SourceClosureResolverAnchor =
	| { kind: "root"; specifier: string }
	| { kind: "member"; importer: SourceClosureLocator; specifier: string };

export interface LifecycleSourceClosureMember extends SourceClosureLocator {
	resolverAnchor: SourceClosureResolverAnchor;
	byteLength: number;
	byteDigest: string;
}

export interface LifecycleSourceClosureManifest {
	schemaVersion: typeof LIFECYCLE_SOURCE_CLOSURE_SCHEMA_VERSION;
	members: readonly LifecycleSourceClosureMember[];
	digest: string;
}

export interface SourceClosureFileSystem {
	resolveImport(specifier: string, fromFile: string): Promise<string>;
	realpath(filePath: string): Promise<string>;
	readFile(filePath: string): Promise<Uint8Array>;
	readPackageJson(filePath: string): Promise<{ name: string; version: string }>;
}

export interface MaterializedLifecycleSourceClosure {
	digest: string;
	members: readonly { locator: SourceClosureLocator; filePath: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && actualKeys.every(key => keys.includes(key));
}

function requiredDelimiterString(value: unknown, name: string): string {
	const string = requiredString(value, name);
	if (string.includes("\0")) throw new Error(`Invalid lifecycle source closure ${name}`);
	return string;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid lifecycle source closure ${name}`);
	return value;
}

function validateRelativePath(value: string): void {
	if (
		value.includes("\0") ||
		value.includes("\\") ||
		path.posix.isAbsolute(value) ||
		value.split("/").some(part => part === "" || part === "." || part === "..")
	) {
		throw new Error("Invalid lifecycle source closure packageRelativePath");
	}
}

function parseLocator(value: unknown): SourceClosureLocator {
	if (!isRecord(value)) throw new Error("Invalid lifecycle source closure locator");
	const packageName = requiredDelimiterString(value.packageName, "packageName");
	const packageVersion = requiredDelimiterString(value.packageVersion, "packageVersion");
	const packageRelativePath = requiredDelimiterString(value.packageRelativePath, "packageRelativePath");
	return sourceClosureLocator({ packageName, packageVersion }, packageRelativePath);
}

function sameLocator(left: SourceClosureLocator, right: SourceClosureLocator): boolean {
	return (
		left.packageName === right.packageName &&
		left.packageVersion === right.packageVersion &&
		left.packageRelativePath === right.packageRelativePath
	);
}

function parseAnchor(value: unknown): SourceClosureResolverAnchor {
	if (!isRecord(value)) throw new Error("Invalid lifecycle source closure resolverAnchor");
	const kind = requiredString(value.kind, "resolverAnchor.kind");
	const specifier = requiredDelimiterString(value.specifier, "resolverAnchor.specifier");
	if (kind === "root" && hasExactKeys(value, ["kind", "specifier"])) return { kind, specifier };
	if (
		kind === "member" &&
		hasExactKeys(value, ["kind", "importer", "specifier"]) &&
		isRecord(value.importer) &&
		hasExactKeys(value.importer, ["packageName", "packageVersion", "packageRelativePath"])
	) {
		return { kind, importer: parseLocator(value.importer), specifier };
	}
	throw new Error("Invalid lifecycle source closure resolverAnchor.kind");
}

/** Parse an untrusted generated closure manifest without accepting layout paths. */
export function parseLifecycleSourceClosureManifest(value: unknown): LifecycleSourceClosureManifest {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "members", "digest"]) ||
		value.schemaVersion !== LIFECYCLE_SOURCE_CLOSURE_SCHEMA_VERSION ||
		!Array.isArray(value.members) ||
		typeof value.digest !== "string" ||
		!DIGEST_PATTERN.test(value.digest)
	) {
		throw new Error("Invalid lifecycle source closure manifest");
	}
	if (value.members.length === 0 || value.members.length > LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBERS) {
		throw new Error("Invalid lifecycle source closure member count");
	}
	const members: LifecycleSourceClosureMember[] = [];
	const locators = new Set<string>();
	const anchors = new Set<string>();
	for (const rawMember of value.members) {
		if (
			!isRecord(rawMember) ||
			!hasExactKeys(rawMember, [
				"packageName",
				"packageVersion",
				"packageRelativePath",
				"resolverAnchor",
				"byteLength",
				"byteDigest",
			]) ||
			typeof rawMember.byteLength !== "number" ||
			!Number.isSafeInteger(rawMember.byteLength) ||
			rawMember.byteLength < 0 ||
			rawMember.byteLength > LIFECYCLE_SOURCE_CLOSURE_MAX_MEMBER_BYTES ||
			typeof rawMember.byteDigest !== "string" ||
			!DIGEST_PATTERN.test(rawMember.byteDigest)
		) {
			throw new Error("Invalid lifecycle source closure member digest");
		}
		const locator = parseLocator(rawMember);
		const key = canonicalSourceClosureLocator(locator);
		if (locators.has(key)) throw new Error("Duplicate lifecycle source closure member");
		const resolverAnchor = parseAnchor(rawMember.resolverAnchor);
		const anchorKey = canonicalSourceClosureResolverAnchor(resolverAnchor);
		if (anchors.has(anchorKey)) throw new Error("Duplicate lifecycle source closure resolver anchor");
		locators.add(key);
		anchors.add(anchorKey);
		members.push({ ...locator, resolverAnchor, byteLength: rawMember.byteLength, byteDigest: rawMember.byteDigest });
	}
	for (const member of members) {
		const anchor = member.resolverAnchor;
		if (anchor.kind === "member" && !members.some(candidate => sameLocator(candidate, anchor.importer))) {
			throw new Error("Lifecycle source closure anchor importer is not a member");
		}
	}
	if (value.digest !== digestLifecycleSourceClosureMembers(members))
		throw new Error("Invalid lifecycle source closure manifest digest");
	return { schemaVersion: LIFECYCLE_SOURCE_CLOSURE_SCHEMA_VERSION, members, digest: value.digest };
}

export function canonicalSourceClosureLocator(locator: SourceClosureLocator): string {
	return `${locator.packageName}\0${locator.packageVersion}\0${locator.packageRelativePath}`;
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function findPackageRoot(
	resolvedFile: string,
	expected: SourceClosureLocator,
	io: SourceClosureFileSystem,
): Promise<string> {
	let candidate = path.dirname(path.resolve(resolvedFile));
	const matchingRoots: string[] = [];
	for (let index = 0; index < MAX_PACKAGE_ANCESTORS; index += 1) {
		let metadata: { name: string; version: string } | undefined;
		try {
			metadata = await io.readPackageJson(path.join(candidate, "package.json"));
		} catch (error) {
			const code =
				error !== null && typeof error === "object" && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		}
		if (metadata) {
			if (metadata.name === expected.packageName && metadata.version === expected.packageVersion) {
				matchingRoots.push(candidate);
			} else if (matchingRoots.length === 0) {
				throw new Error("Lifecycle source closure package resolution mismatch");
			} else {
				break;
			}
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) break;
		candidate = parent;
	}
	if (matchingRoots.length !== 1) throw new Error("Lifecycle source closure package resolution mismatch");
	return matchingRoots[0];
}

export function canonicalSourceClosureResolverAnchor(anchor: SourceClosureResolverAnchor): string {
	return anchor.kind === "root"
		? `root\0${anchor.specifier}`
		: `member\0${canonicalSourceClosureLocator(anchor.importer)}\0${anchor.specifier}`;
}

export function digestLifecycleSourceClosureMembers(members: readonly LifecycleSourceClosureMember[]): string {
	const canonical = [...members]
		.sort((left, right) => canonicalSourceClosureLocator(left).localeCompare(canonicalSourceClosureLocator(right)))
		.map(
			member =>
				`${canonicalSourceClosureLocator(member)}\0${canonicalSourceClosureResolverAnchor(member.resolverAnchor)}\0${member.byteLength}\0${member.byteDigest}`,
		)
		.join("\n");
	return crypto.createHash("sha256").update(`lifecycle-source-closure-v1\n${canonical}`).digest("hex");
}

/** Strictly resolve and hash only the files declared by the generated manifest. */
export async function materializeLifecycleSourceClosure(
	manifestInput: unknown,
	io: SourceClosureFileSystem,
	rootAnchorFile: string,
): Promise<MaterializedLifecycleSourceClosure> {
	const manifest = parseLifecycleSourceClosureManifest(manifestInput);
	const resolved = new Map<string, string>();
	let totalBytes = 0;
	for (const member of manifest.members) {
		const locatorKey = canonicalSourceClosureLocator(member);
		let fromFile = rootAnchorFile;
		if (member.resolverAnchor.kind === "member") {
			const importer = resolved.get(canonicalSourceClosureLocator(member.resolverAnchor.importer));
			if (!importer) throw new Error("Lifecycle source closure anchor importer was not materialized");
			fromFile = importer;
		}
		const resolvedImport = await io.resolveImport(member.resolverAnchor.specifier, fromFile);
		const packageRoot = await findPackageRoot(resolvedImport, member, io);
		const candidate = path.join(packageRoot, member.packageRelativePath);
		const filePath = await io.realpath(candidate);
		if (filePath !== (await io.realpath(resolvedImport)) || !isContained(packageRoot, filePath)) {
			throw new Error("Lifecycle source closure resolver anchor or member escapes package root");
		}
		if (resolved.has(locatorKey)) throw new Error("Duplicate lifecycle source closure materialization");
		const bytes = await io.readFile(filePath);
		if (
			bytes.byteLength !== member.byteLength ||
			crypto.createHash("sha256").update(bytes).digest("hex") !== member.byteDigest
		) {
			throw new Error("Lifecycle source closure member digest mismatch");
		}
		totalBytes += bytes.byteLength;
		if (totalBytes > LIFECYCLE_SOURCE_CLOSURE_MAX_TOTAL_BYTES)
			throw new Error("Lifecycle source closure exceeds byte cap");
		resolved.set(locatorKey, filePath);
	}
	return {
		digest: digestLifecycleSourceClosureMembers(manifest.members),
		members: manifest.members.map(member => ({
			locator: sourceClosureLocator(
				{ packageName: member.packageName, packageVersion: member.packageVersion },
				member.packageRelativePath,
			),
			filePath: resolved.get(canonicalSourceClosureLocator(member))!,
		})),
	};
}

const productionSourceClosureFileSystem: SourceClosureFileSystem = {
	async resolveImport(specifier, fromFile) {
		return Bun.resolveSync(specifier, path.dirname(fromFile));
	},
	async realpath(filePath) {
		return await fs.realpath(filePath);
	},
	async readFile(filePath) {
		return await fs.readFile(filePath);
	},
	async readPackageJson(filePath) {
		const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
		if (!isRecord(parsed)) throw new Error("Invalid package metadata");
		return {
			name: typeof parsed.name === "string" ? parsed.name : "",
			version: typeof parsed.version === "string" ? parsed.version : "",
		};
	},
};

/** Production resolver used only by worktree runtime fingerprinting. */
export async function materializeLifecycleSourceClosureFromRuntime(
	manifest: unknown,
): Promise<MaterializedLifecycleSourceClosure> {
	return await materializeLifecycleSourceClosure(
		manifest,
		productionSourceClosureFileSystem,
		fileURLToPath(import.meta.url),
	);
}
