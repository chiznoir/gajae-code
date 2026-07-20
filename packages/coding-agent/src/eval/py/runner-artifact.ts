import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DIRECTORY_PREFIX = "gjc-python-runner-";

async function initializeRunnerScript(tempRoot: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(tempRoot, DIRECTORY_PREFIX));
	try {
		if (process.platform !== "win32") await fs.chmod(directory, DIRECTORY_MODE);
		const scriptPath = path.join(directory, "runner.py");
		const handle = await fs.open(scriptPath, "wx", FILE_MODE);
		try {
			await handle.writeFile(RUNNER_SCRIPT, { encoding: "utf8" });
			if (process.platform !== "win32") await handle.chmod(FILE_MODE);
		} finally {
			await handle.close();
		}
		return scriptPath;
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

export function createRunnerScriptInitializer(tempRoot: string): () => Promise<string> {
	let initialization: Promise<string> | null = null;
	return async () => {
		if (initialization) return await initialization;
		const attempt = initializeRunnerScript(tempRoot);
		initialization = attempt;
		try {
			return await attempt;
		} catch (error) {
			if (initialization === attempt) initialization = null;
			throw error;
		}
	};
}

export const ensureRunnerScript = createRunnerScriptInitializer(os.tmpdir());
