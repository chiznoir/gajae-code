import * as crypto from "node:crypto";
import * as fs from "node:fs";

export const PSMUX_LIFECYCLE_NAMESPACE = "gjc-lifecycle";
export const PSMUX_LIFECYCLE_MARKER_ENV = "GJC_PSMUX_LIFECYCLE_PRIMARY_MARKER";
const markerPattern = /^[A-Za-z0-9_-]{43}$/;
const REVIEWED_PSMUX_SHA256 = "3b5954da02caabfcf9d55f644a759d7a10ace90089a58764a9aa373a046a9d2c";
const REVIEWED_PSMUX_VERSION = "tmux 3.3.6";

export function createPsmuxLifecycleMarker(): string {
	return crypto.randomBytes(32).toString("base64url");
}

export function isPsmuxLifecycleMarker(value: unknown): value is string {
	return typeof value === "string" && markerPattern.test(value);
}

export function psmuxLifecycleSessionName(sessionId: string): string {
	return `gjc_lc_${sessionId}`;
}

export function resolvePsmuxLifecycleExecutable(command: string): string {
	return Bun.which(command) ?? command;
}

export function isReviewedPsmuxLifecycleExecutable(command: string): boolean {
	const executable = resolvePsmuxLifecycleExecutable(command);
	try {
		const sha256 = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
		const version = Bun.spawnSync([executable, "-V"], { stdout: "pipe", stderr: "pipe" });
		return (
			sha256 === REVIEWED_PSMUX_SHA256 &&
			version.exitCode === 0 &&
			version.stdout.toString().trim() === REVIEWED_PSMUX_VERSION
		);
	} catch {
		return false;
	}
}

export function psmuxLifecycleArgv(executable: string, args: string[]): string[] {
	return [executable, "-L", PSMUX_LIFECYCLE_NAMESPACE, ...args];
}

export function psmuxExactSessionTarget(sessionName: string): string {
	if (!sessionName || /[\r\n\0]/.test(sessionName)) throw new Error("invalid_psmux_session_name");
	return `=${sessionName}`;
}

/** Accept exactly one well-formed requested assignment; provider lines are ignored. */
export function readPsmuxMarkerLine(output: string): string | undefined {
	const matches = output
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.filter(line => line.startsWith(`${PSMUX_LIFECYCLE_MARKER_ENV}=`));
	if (matches.length !== 1) return undefined;
	const marker = matches[0]!.slice(PSMUX_LIFECYCLE_MARKER_ENV.length + 1);
	return isPsmuxLifecycleMarker(marker) ? marker : undefined;
}
