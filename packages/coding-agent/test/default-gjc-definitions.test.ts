import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_GJC_DEFINITION_NAMES,
	getDefaultGjcDefinitions,
	installDefaultGjcDefinitions,
} from "@gajae-code/coding-agent/defaults/gjc-defaults";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-definitions-"));
	tempRoots.push(tempRoot);
	return tempRoot;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("default GJC definitions", () => {
	it("bundles exactly the four default skills and four default agents as source assets", () => {
		const definitions = getDefaultGjcDefinitions();
		const skills = definitions
			.filter(definition => definition.kind === "skill")
			.map(definition => definition.name)
			.sort();
		const agents = definitions
			.filter(definition => definition.kind === "agent")
			.map(definition => definition.name)
			.sort();
		const expected = [...DEFAULT_GJC_DEFINITION_NAMES].sort();

		expect(skills).toEqual(expected);
		expect(agents).toEqual(expected);
		expect(definitions).toHaveLength(8);
		expect(definitions.every(definition => definition.content.includes(definition.name))).toBe(true);
	});

	it("installs bundled definitions without overwriting local edits unless forced", async () => {
		const targetRoot = await makeTempRoot();
		const initial = await installDefaultGjcDefinitions({ targetRoot });
		const deepInterviewSkillPath = path.join(targetRoot, "skills", "deep-interview", "SKILL.md");
		const installedDeepInterview = await Bun.file(deepInterviewSkillPath).text();

		expect(initial.written).toBe(8);
		expect(initial.skipped).toBe(0);

		await Bun.write(deepInterviewSkillPath, "local edit");
		const skipped = await installDefaultGjcDefinitions({ targetRoot });
		expect(skipped.written).toBe(0);
		expect(skipped.skipped).toBe(8);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe("local edit");

		const check = await installDefaultGjcDefinitions({ targetRoot, check: true });
		expect(check.different).toBe(1);
		expect(check.matching).toBe(7);

		const forced = await installDefaultGjcDefinitions({ targetRoot, force: true });
		expect(forced.written).toBe(8);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe(installedDeepInterview);
	});
});
