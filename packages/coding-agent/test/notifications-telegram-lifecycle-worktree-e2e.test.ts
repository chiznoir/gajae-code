import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";

const roots: string[] = [];
const agentDirs: string[] = [];
const tmuxFixtures: TmuxFixture[] = [];

interface TmuxFixture {
	dir: string;
	socket: string;
	command: string;
}

function commandWorks(command: string, args: string[]): boolean {
	const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0;
}

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

const unsupportedPrerequisite =
	process.platform === "win32"
		? "requires a POSIX tmux server"
		: Bun.which("git") === null || !commandWorks("git", ["--version"])
			? "requires a working git executable"
			: Bun.which("tmux") === null || !commandWorks("tmux", ["-V"])
				? "requires a working tmux executable"
				: null;

function createTmuxFixture(): TmuxFixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-worktree-tmux-"));
	const socket = path.join(dir, "server.sock");
	const command = path.join(dir, "tmux-fixture");
	fs.writeFileSync(command, `#!/bin/sh\nexec tmux -S '${socket}' "$@"\n`, { mode: 0o700 });
	const fixture = { dir, socket, command };
	tmuxFixtures.push(fixture);
	return fixture;
}

function tmux(fixture: TmuxFixture, args: string[]): string {
	const result = Bun.spawnSync(["tmux", "-S", fixture.socket, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function tmuxSessionNames(fixture: TmuxFixture): string[] {
	const result = Bun.spawnSync(["tmux", "-S", fixture.socket, "list-sessions", "-F", "#{session_name}"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return [];
	return result.stdout
		.toString()
		.split("\n")
		.map(name => name.trim())
		.filter(Boolean);
}

function tmuxOption(fixture: TmuxFixture, session: string, option: string): string {
	return tmux(fixture, ["show-options", "-v", "-t", session, option]);
}

function fixtureSettings(agentDir: string): Settings {
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:test-token",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(base, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function createRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-worktree-e2e-"));
	roots.push(repo);
	git(["init"], repo);
	git(["config", "user.email", "test@example.com"], repo);
	git(["config", "user.name", "Test User"], repo);
	fs.writeFileSync(path.join(repo, "tracked-sentinel.txt"), "primary\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), ".gjc/\n");
	git(["add", "tracked-sentinel.txt", ".gitignore"], repo);
	git(["commit", "-m", "initial"], repo);
	return repo;
}

afterEach(() => {
	for (const fixture of tmuxFixtures.splice(0)) {
		Bun.spawnSync(["tmux", "-S", fixture.socket, "kill-server"]);
		fs.rmSync(fixture.dir, { recursive: true, force: true });
	}
	for (const repo of roots.splice(0)) {
		const worktreeRoot = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		for (const line of git(["worktree", "list", "--porcelain"], repo).split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			const candidate = line.slice("worktree ".length);
			if (candidate !== repo) Bun.spawnSync(["git", "worktree", "remove", "--force", candidate], { cwd: repo });
		}
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(worktreeRoot, { recursive: true, force: true });
	}
	for (const agentDir of agentDirs.splice(0)) fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("Telegram /session_create worktree isolation", () => {
	(unsupportedPrerequisite ? test.skip : test)(
		"dispatches the exact command into a disposable named worktree without changing the primary checkout",
		async () => {
			const repo = createRepo();
			const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-worktree-agent-"));
			const tmuxFixture = createTmuxFixture();
			agentDirs.push(agentDir);
			const primary = {
				topLevel: git(["rev-parse", "--show-toplevel"], repo),
				head: git(["rev-parse", "HEAD"], repo),
				branch: git(["branch", "--show-current"], repo),
				index: fs.readFileSync(path.join(repo, ".git", "index")),
				status: git(["status", "--porcelain=v1"], repo),
				sentinel: fs.readFileSync(path.join(repo, "tracked-sentinel.txt"), "utf8"),
			};
			const calls: { method: string; body: Record<string, unknown> | null }[] = [];
			const daemon = new TelegramNotificationDaemon({
				settings: fixtureSettings(agentDir),
				ownerId: "telegram-worktree-e2e",
				botToken: "123456:test-token",
				chatId: "42",
				botApi: {
					call: async (method: string, body: Record<string, unknown> | null) => {
						calls.push({ method, body });
						if (method === "getChat") return { ok: true, result: { id: body?.chat_id, type: "private" } };
						return { ok: true, result: [] };
					},
				} as never,
			});
			const lifecycleControl = daemon as unknown as {
				startLifecycleControl: () => Promise<boolean>;
				stopLifecycleControl: () => void;
			};
			const previousTmuxCommand = process.env.GJC_TMUX_COMMAND;
			process.env.GJC_TMUX_COMMAND = tmuxFixture.command;
			try {
				expect(await lifecycleControl.startLifecycleControl()).toBe(true);
				await daemon.handleTelegramUpdate({
					update_id: 71,
					message: {
						chat: { id: "42", type: "private" },
						message_id: 71,
						text: `/session_create worktree ${repo} fix-telegram-close`,
					},
				});

				const createdTmuxSessions = tmuxSessionNames(tmuxFixture);
				expect(createdTmuxSessions).toHaveLength(1);
				const tmuxSession = createdTmuxSessions[0]!;
				const sessionId = tmuxOption(tmuxFixture, tmuxSession, "@gjc-session-id");
				const sessionStateFile = tmuxOption(tmuxFixture, tmuxSession, "@gjc-session-state-file");
				expect(sessionId).toMatch(/^s[0-9a-f]{12}$/);

				const worktreeRoot = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
				const worktree = git(["worktree", "list", "--porcelain"], repo)
					.split("\n")
					.find(line => line.startsWith("worktree ") && line.includes(worktreeRoot))!
					.slice("worktree ".length);
				expect(git(["rev-parse", "--show-toplevel"], worktree)).toBe(worktree);
				expect(git(["branch", "--show-current"], worktree)).toBe("fix-telegram-close");
				expect(worktree).not.toBe(repo);
				expect(fs.statSync(worktree).isDirectory()).toBe(true);
				expect(fs.existsSync(path.join(repo, "fix-telegram-close"))).toBe(false);
				expect(tmuxOption(tmuxFixture, tmuxSession, "@gjc-project")).toBe(worktree);

				const gjcRoot = path.join(repo, ".gjc");
				expect(sessionStateFile.startsWith(`${gjcRoot}${path.sep}`)).toBe(true);
				const lifecycleRoot = path.join(path.dirname(sessionStateFile), sessionId, "owner-lifecycle");
				expect(lifecycleRoot.startsWith(`${gjcRoot}${path.sep}`)).toBe(true);
				const lifecycleFiles = fs.readdirSync(lifecycleRoot);
				const attestationFile = lifecycleFiles.find(file => file.endsWith(".attestation.json"));
				const readinessFile = lifecycleFiles.find(file => file.endsWith(".ready.json"));
				expect(attestationFile).toBeDefined();
				expect(readinessFile).toBeDefined();
				const attestationBytes = fs.readFileSync(path.join(lifecycleRoot, attestationFile!));
				const readiness = JSON.parse(fs.readFileSync(path.join(lifecycleRoot, readinessFile!), "utf8")) as {
					attestation_sha256?: string;
				};
				expect(readiness.attestation_sha256).toBe(
					crypto.createHash("sha256").update(attestationBytes).digest("hex"),
				);
				expect(git(["rev-parse", "--show-toplevel"], repo)).toBe(primary.topLevel);
				expect(git(["rev-parse", "HEAD"], repo)).toBe(primary.head);
				expect(git(["branch", "--show-current"], repo)).toBe(primary.branch);
				expect(fs.readFileSync(path.join(repo, ".git", "index"))).toEqual(primary.index);
				expect(git(["status", "--porcelain=v1"], repo)).toBe(primary.status);
				expect(fs.readFileSync(path.join(repo, "tracked-sentinel.txt"), "utf8")).toBe(primary.sentinel);
				expect(calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
				expect(String(calls.find(call => call.method === "sendMessage")?.body?.text)).toContain(sessionId);
			} finally {
				lifecycleControl.stopLifecycleControl();
				if (previousTmuxCommand === undefined) delete process.env.GJC_TMUX_COMMAND;
				else process.env.GJC_TMUX_COMMAND = previousTmuxCommand;
			}
		},
		60_000,
	);
});
