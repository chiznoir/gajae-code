#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

const expected = ["deep-interview", "ralplan", "team", "ultragoal"];
const repoRoot = process.cwd();

function listSkillDirs(dir: string): string[] {
	const full = path.join(repoRoot, dir);
	if (!fs.existsSync(full)) return [];
	return fs
		.readdirSync(full, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && fs.existsSync(path.join(full, entry.name, "SKILL.md")))
		.map(entry => entry.name);
}

function listDefinitionFiles(dir: string, extensions: readonly string[]): string[] {
	const full = path.join(repoRoot, dir);
	if (!fs.existsSync(full)) return [];
	return fs
		.readdirSync(full, { withFileTypes: true })
		.filter(entry => entry.isFile() && extensions.some(extension => entry.name.endsWith(extension)))
		.map(entry => {
			const extension = extensions.find(candidate => entry.name.endsWith(candidate));
			return extension ? entry.name.slice(0, -extension.length) : entry.name;
		});
}

const visibleSkills = listSkillDirs(".gjc/skills").sort();
const visibleAgents = listDefinitionFiles(".gjc/agents", [".md", ".toml"]).sort();
const bundledSkills = listSkillDirs("packages/coding-agent/src/defaults/gjc/skills").sort();
const bundledAgents = listDefinitionFiles("packages/coding-agent/src/defaults/gjc/agents", [".md"]).sort();
const otherVisibleDefinitions = [
	...listDefinitionFiles(".gjc/commands", [".md"]),
	...listDefinitionFiles(".gjc/rules", [".md"]),
].sort();
const visible = [...visibleSkills, ...visibleAgents, ...otherVisibleDefinitions].sort();

const unexpected = visible.filter(name => !expected.includes(name));
const missingSkills = expected.filter(name => !visibleSkills.includes(name));
const missingAgents = expected.filter(name => !visibleAgents.includes(name));
const missingBundledSkills = expected.filter(name => !bundledSkills.includes(name));
const missingBundledAgents = expected.filter(name => !bundledAgents.includes(name));
const ignoredDefinitions = getIgnoredDefinitionPaths([
	...expected.map(name => `.gjc/skills/${name}/SKILL.md`),
	...expected.map(name => `.gjc/agents/${name}.md`),
	...expected.map(name => `packages/coding-agent/src/defaults/gjc/skills/${name}/SKILL.md`),
	...expected.map(name => `packages/coding-agent/src/defaults/gjc/agents/${name}.md`),
]);

if (
	unexpected.length > 0 ||
	missingSkills.length > 0 ||
	missingAgents.length > 0 ||
	missingBundledSkills.length > 0 ||
	missingBundledAgents.length > 0 ||
	ignoredDefinitions.length > 0 ||
	visibleSkills.length !== expected.length ||
	visibleAgents.length !== expected.length ||
	bundledSkills.length !== expected.length ||
	bundledAgents.length !== expected.length ||
	otherVisibleDefinitions.length !== 0
) {
	console.error("Visible definitions mismatch");
	console.error(
		JSON.stringify(
			{
				expected,
				visibleSkills,
				visibleAgents,
				bundledSkills,
				bundledAgents,
				otherVisibleDefinitions,
				missingSkills,
				missingAgents,
				missingBundledSkills,
				missingBundledAgents,
				ignoredDefinitions,
				unexpected,
			},
			null,
			2,
		),
	);
	process.exit(1);
}

console.log(
	`Visible definitions OK: skills=${visibleSkills.join(", ")} agents=${visibleAgents.join(", ")} bundled=${bundledSkills.join(", ")}`,
);

function getIgnoredDefinitionPaths(paths: string[]): string[] {
	const ignored: string[] = [];
	for (const filePath of paths) {
		const result = Bun.spawnSync(["git", "check-ignore", filePath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode === 0) {
			ignored.push(filePath);
		}
	}
	return ignored;
}
