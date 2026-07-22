/** Shared source-vs-compiled runtime detection and worktree-only identity primitives. */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { materializeLifecycleSourceClosureFromRuntime } from "../gjc-runtime/lifecycle-source-closure";
import generatedSourceClosureManifest from "./lifecycle-source-closure.generated.json";

const COMPILED_RELOAD_WARNING =
	"Compiled binary: reload respawns the same binary. Rebuild the binary first for amended source to take effect.";
const MAX_COMPILED_EXECUTABLE_BYTES = 128 * 1024 * 1024;

export interface GjcRuntimeArgv {
	execPath: string;
	mode: "source" | "compiled";
	/** Prefix prepended before the gjc subcommand args. */
	argsPrefix: string[];
}

export interface GjcRuntimeSpawnInfo extends GjcRuntimeArgv {
	/** True only when respawn loads edited TypeScript directly (source/dev mode). */
	reloadPicksUpSourceEdits: boolean;
	/** Set in compiled mode to explain that a rebuild is required before reload picks up source edits. */
	warning?: string;
}

export interface WorktreeRuntimeFingerprint {
	mode: "source" | "compiled";
	digest: string;
}

export interface FingerprintWorktreeRuntimeOptions {
	execPath?: string;
	/** Tests may inject a fixture; source mode otherwise uses the generated manifest. */
	sourceClosureManifest?: unknown;
}

/**
 * Resolve a daemon launch argv using lexical paths only. This deliberately does
 * not stat, realpath, read, hash, or load closure metadata.
 */
export function resolveGjcRuntimeArgv(execPath: string = process.execPath): GjcRuntimeArgv {
	const absoluteExecPath = path.resolve(execPath);
	const base = path.basename(absoluteExecPath).toLowerCase();
	const fromSource = base === "bun" || base === "node" || base.startsWith("bun") || base.startsWith("node");
	if (fromSource) {
		return {
			execPath: absoluteExecPath,
			mode: "source",
			argsPrefix: [path.resolve(import.meta.dir, "../../bin/gjc.js")],
		};
	}
	return { execPath: absoluteExecPath, mode: "compiled", argsPrefix: [] };
}

/** Compatibility shape retained for daemon status and existing spawn callers. */
export function resolveGjcRuntimeSpawnInfo(execPath: string = process.execPath): GjcRuntimeSpawnInfo {
	const argv = resolveGjcRuntimeArgv(execPath);
	return argv.mode === "source"
		? { ...argv, reloadPicksUpSourceEdits: true }
		: { ...argv, reloadPicksUpSourceEdits: false, warning: COMPILED_RELOAD_WARNING };
}

/**
 * Compute identity for the artifact that a worktree-create child will execute.
 * Callers must not use this on ordinary path/dir or cold-resume flows.
 */
export async function fingerprintWorktreeRuntime(
	options: FingerprintWorktreeRuntimeOptions = {},
): Promise<WorktreeRuntimeFingerprint> {
	const argv = resolveGjcRuntimeArgv(options.execPath);
	if (argv.mode === "source") {
		const closure = await materializeLifecycleSourceClosureFromRuntime(
			options.sourceClosureManifest ?? generatedSourceClosureManifest,
		);
		return { mode: "source", digest: closure.digest };
	}
	const executable = await fs.realpath(argv.execPath);
	const stat = await fs.stat(executable);
	if (!stat.isFile() || stat.size < 0 || stat.size > MAX_COMPILED_EXECUTABLE_BYTES) {
		throw new Error("Invalid compiled runtime executable");
	}
	const bytes = await fs.readFile(executable);
	return { mode: "compiled", digest: crypto.createHash("sha256").update(bytes).digest("hex") };
}
