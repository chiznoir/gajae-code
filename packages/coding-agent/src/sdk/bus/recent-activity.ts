/**
 * Recent-activity session picker (G006).
 *
 * Ranks GJC sessions by session-history file mtime (most recent first) and
 * enriches each with terminal-breadcrumb info, so a remote lifecycle client can
 * pick a repo to create in or a recent session to resume without typing raw
 * paths. Dependency-light + injectable so it is unit-testable over a temp dir.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { verifyOwnerOnlyPathSecurity } from "@gajae-code/natives";
import { getAgentDir, getSessionsDir } from "@gajae-code/utils";
import {
	inspectManagedCandidateForRecent,
	listManagedCandidates,
	type ManagedCandidate,
	type ManagedRecentCandidateInspection,
	type ManagedScope,
	projectManagedCandidates,
	type ReadonlyScopeAuthority,
	readonlyAuthorityForManagedScope,
	resolveManagedScope,
} from "../../session/internal/managed-session-scope";
import { captureManagedFilePrefixNoFollow } from "../../session/internal/managed-session-storage";

/** One ranked recent-session entry surfaced to the picker. */
export interface RecentSessionEntry {
	/** Session id from the validated managed candidate header. */
	sessionId: string;
	/** Validated workspace path recorded by the managed candidate. */
	path?: string;
	/** Branch, when recoverable from the header. */
	branch?: string;
	/** A short title (first user message), when recoverable. */
	title?: string;
	/** Absolute path of the session history (state) file. */
	sessionStateFile: string;
	/** Last-activity epoch-millis (history file mtime). */
	mtimeMs: number;
	/** True when a terminal breadcrumb points at this session file. */
	currentTerminal?: boolean;
	/** True when this history is an internal helper/sub-agent session. */
	internal?: boolean;
}

export interface RecentActivityDeps {
	/** Workspace whose managed sessions will be listed readonly. */
	cwd: string;
	/** Agent directory used to resolve the managed session scope. */
	agentDir?: string;
	/** Explicit managed root for isolated tests. */
	sessionsRoot?: string;
	/** Optional breadcrumb session-file paths (current terminals). */
	breadcrumbPaths?: string[];
	/** Max entries to return (default 20). */
	limit?: number;
	/** Include internal helper/sub-agent sessions (default true). */
	includeInternal?: boolean;
	/** Search every validated v2 workspace scope below the session root (default false). */
	allWorkspaces?: boolean;
	/** Injection seam retained for callers that provide independently read metadata. */
	readInitialLines?: (file: string, maxLines: number) => string[];
}

/** Best-effort header metadata extraction from a session file's first line. */
function headerMeta(line: string | undefined): { branch?: string; title?: string } {
	if (!line) return {};
	try {
		const obj = JSON.parse(line) as Record<string, unknown>;
		const branch = typeof obj.branch === "string" ? obj.branch : undefined;
		const title = typeof obj.title === "string" ? obj.title : undefined;
		return { branch, title };
	} catch {
		return {};
	}
}

/** Detect task-tool helper sessions from the durable early session_init metadata entry. */
function isInternalSession(lines: readonly string[]): boolean {
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as unknown;
			if (typeof obj === "object" && obj !== null && (obj as { type?: unknown }).type === "session_init") {
				return true;
			}
		} catch {
			// Ignore malformed JSONL entries; classification is best-effort.
		}
	}
	return false;
}

function sameInitialLines(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

function candidatePathIdentityKey(candidate: ManagedCandidate): string {
	return [
		path.resolve(candidate.path),
		candidate.identity.dev.toString(),
		candidate.identity.ino.toString(),
		candidate.identity.size.toString(),
		candidate.identity.mtimeNs.toString(),
		candidate.identity.sha256,
	].join("\0");
}

/** Lists readonly managed candidates, optionally across every validated v2 workspace scope, ranked by history-file mtime. */
export type ListRecentSessionsResult =
	| { kind: "complete"; entries: RecentSessionEntry[]; warnings: readonly string[] }
	| { kind: "error"; code: "scope_unavailable" | "managed_scan_failed"; message: string };

async function resolveRecentScopes(
	deps: RecentActivityDeps,
): Promise<
	| { kind: "complete"; scopes: ManagedScope[]; warnings: string[] }
	| { kind: "error"; code: "scope_unavailable"; message: string }
> {
	const agentDir = deps.agentDir ?? getAgentDir();
	const sessionsRoot = deps.sessionsRoot ?? getSessionsDir(agentDir);
	const current = resolveManagedScope({
		cwd: deps.cwd,
		agentDir,
		sessionsRoot,
	});
	if (!deps.allWorkspaces) {
		if (current.kind !== "resolved") return { kind: "error", code: "scope_unavailable", message: current.message };
		return { kind: "complete", scopes: [current.scope], warnings: [] };
	}
	try {
		const root = await fs.lstat(sessionsRoot);
		if (!root.isDirectory() || root.isSymbolicLink() || !verifyOwnerOnlyPathSecurity(sessionsRoot, "directory").ok) {
			return {
				kind: "error",
				code: "scope_unavailable",
				message: "The managed sessions root is not a safe directory.",
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "complete", scopes: [], warnings: [] };
		return { kind: "error", code: "scope_unavailable", message: "The managed sessions root could not be inspected." };
	}
	const warnings: string[] = [];
	const scopes = current.kind === "resolved" ? [current.scope] : [];
	const seen = new Set(scopes.map(scope => scope.directoryPath));

	const addResolvedScope = async (cwd: string, expectedDirectory?: string): Promise<void> => {
		const resolved = resolveManagedScope({
			cwd,
			agentDir,
			sessionsRoot,
		});
		if (resolved.kind !== "resolved") {
			if (resolved.code !== "cwd_missing" && resolved.code !== "cwd_not_directory")
				warnings.push("Ignored invalid managed session scope binding.");
			return;
		}
		if (expectedDirectory !== undefined && resolved.scope.directoryPath !== expectedDirectory) {
			warnings.push("Ignored invalid managed session scope binding.");
			return;
		}
		if (!seen.has(resolved.scope.directoryPath)) {
			seen.add(resolved.scope.directoryPath);
			scopes.push(resolved.scope);
		}
	};
	try {
		const directories = await fs.readdir(sessionsRoot, { withFileTypes: true });
		for (const directory of directories) {
			if (!directory.isDirectory() || directory.isSymbolicLink() || !directory.name.startsWith("v2-")) continue;
			try {
				const binding = JSON.parse(
					await fs.readFile(path.join(sessionsRoot, directory.name, ".gjc-managed-session-scope.v2.json"), "utf8"),
				) as { canonicalPath?: unknown };
				if (typeof binding.canonicalPath !== "string") {
					warnings.push("Ignored invalid managed session scope binding.");
					continue;
				}
				await addResolvedScope(binding.canonicalPath, path.join(sessionsRoot, directory.name));
			} catch {
				warnings.push("Ignored unreadable managed session scope binding.");
			}
		}
		for (const directory of directories) {
			if (!directory.isDirectory() || directory.isSymbolicLink() || directory.name.startsWith("v2-")) continue;
			try {
				const files = await fs.readdir(path.join(sessionsRoot, directory.name), {
					withFileTypes: true,
				});
				for (const file of files) {
					if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".jsonl")) continue;
					try {
						const snapshot = captureManagedFilePrefixNoFollow(
							path.join(sessionsRoot, directory.name, file.name),
							64 * 1024,
						);
						const newline = snapshot.bytes.indexOf(0x0a);
						if (newline < 0) continue;
						const header = JSON.parse(Buffer.from(snapshot.bytes.subarray(0, newline)).toString("utf8")) as {
							cwd?: unknown;
							type?: unknown;
						};
						if (header.type === "session" && typeof header.cwd === "string") await addResolvedScope(header.cwd);
					} catch {
						warnings.push("Ignored unreadable legacy managed session candidate.");
					}
				}
			} catch {
				warnings.push("Ignored unreadable legacy managed session directory.");
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "complete", scopes, warnings };
		return { kind: "error", code: "scope_unavailable", message: "The managed sessions root could not be read." };
	}
	return { kind: "complete", scopes, warnings };
}

export async function listRecentSessions(deps: RecentActivityDeps): Promise<ListRecentSessionsResult> {
	const limit = deps.limit ?? 20;
	const includeInternal = deps.includeInternal ?? true;
	const breadcrumbs = new Set((deps.breadcrumbPaths ?? []).map(candidate => path.resolve(candidate)));
	const resolved = await resolveRecentScopes(deps);
	if (resolved.kind === "error") return resolved;
	const warnings = [...resolved.warnings];
	const candidates: Array<{
		scope: ManagedScope;
		candidate: ManagedCandidate;
		authority: ReadonlyScopeAuthority;
	}> = [];
	for (const scope of resolved.scopes) {
		let authority: ReadonlyScopeAuthority;
		try {
			authority = readonlyAuthorityForManagedScope(scope);
		} catch {
			return {
				kind: "error",
				code: "managed_scan_failed",
				message: "Managed session scope could not be inspected.",
			};
		}
		const listed = listManagedCandidates(scope, { preflightOnly: true });
		if (listed.kind !== "complete") {
			return { kind: "error", code: "managed_scan_failed", message: listed.message };
		}
		candidates.push(...listed.owned.map(candidate => ({ scope, candidate, authority })));
		warnings.push(
			...listed.invalid
				.filter(
					invalid =>
						!deps.allWorkspaces || (invalid.code !== "cwd_not_found" && invalid.code !== "cwd_not_directory"),
				)
				.map(invalid => `Ignored invalid managed session candidate: ${invalid.code}`),
		);
	}

	const MAX_SOURCE_CHANGED_CAPTURE_ATTEMPTS = 2;
	const captured: Array<{
		scope: ManagedScope;
		inspection: Extract<ManagedRecentCandidateInspection, { kind: "owned" }>;
	}> = [];
	for (const { scope, candidate, authority } of candidates) {
		let inspected: ManagedRecentCandidateInspection | undefined;
		for (let attempt = 0; attempt < MAX_SOURCE_CHANGED_CAPTURE_ATTEMPTS; attempt++) {
			inspected = inspectManagedCandidateForRecent(scope, candidate, authority);
			if (inspected.kind !== "candidate_omitted" || inspected.reason !== "source_changed") break;
		}
		if (!inspected || inspected.kind === "candidate_omitted") {
			warnings.push("Ignored managed session candidate that changed during inspection.");
			continue;
		}
		if (inspected.kind === "scope_invalid") {
			return { kind: "error", code: "managed_scan_failed", message: inspected.message };
		}
		captured.push({ scope, inspection: inspected });
	}
	const activeByScope = new Map<ManagedScope, ManagedCandidate[]>();
	for (const { scope, inspection } of captured) {
		const candidatesForScope = activeByScope.get(scope) ?? [];
		candidatesForScope.push(inspection.candidate);
		activeByScope.set(scope, candidatesForScope);
	}
	const projectedByScope = new Map<ManagedScope, Map<string, ManagedCandidate>>();
	for (const scope of resolved.scopes) {
		const accepted = new Map<string, ManagedCandidate>();
		for (const candidate of projectManagedCandidates(scope, activeByScope.get(scope) ?? []))
			accepted.set(candidatePathIdentityKey(candidate), candidate);
		projectedByScope.set(scope, accepted);
	}
	const entries: RecentSessionEntry[] = [];
	for (const { scope, inspection } of captured) {
		const active = projectedByScope.get(scope)?.get(candidatePathIdentityKey(inspection.candidate));
		if (!active) continue;
		let initialLines = inspection.initialLines;
		if (deps.readInitialLines) {
			try {
				const callbackLines = deps.readInitialLines(inspection.candidate.path, 8);
				if (!sameInitialLines(callbackLines, inspection.initialLines)) {
					warnings.push("Ignored managed session candidate with mismatched injected metadata.");
					continue;
				}
				initialLines = callbackLines;
			} catch {
				warnings.push("Ignored managed session candidate with unreadable injected metadata.");
				continue;
			}
		}
		const meta = headerMeta(initialLines[0]);
		const internal = isInternalSession(initialLines);
		if (internal && !includeInternal) continue;
		entries.push({
			sessionId: active.sessionId,
			path: active.cwd,
			branch: meta.branch,
			title: meta.title,
			sessionStateFile: active.path,
			mtimeMs: active.identity.mtimeMs,
			currentTerminal: breadcrumbs.has(path.resolve(active.path)) || undefined,
			internal: internal || undefined,
		});
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return {
		kind: "complete",
		entries: entries.slice(0, limit),
		warnings,
	};
}
