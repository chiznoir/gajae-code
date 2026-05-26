import { Command } from "@gajae-code/utils/cli";
import { runBridgedRuntimeEndpoint } from "./gjc-runtime-bridge";

export default class DeepInterview extends Command {
	static description = "Run private GJC deep-interview workflow commands";
	static strict = false;
	static examples = ["$ gjc deep-interview --help"];

	async run(): Promise<void> {
		await runBridgedRuntimeEndpoint("deep-interview", this.argv);
	}
}
