import { Command } from "@gajae-code/utils/cli";
import { runBridgedRuntimeEndpoint } from "./gjc-runtime-bridge";

export default class Ralplan extends Command {
	static description = "Run private GJC RALPLAN workflow commands";
	static strict = false;
	static examples = ["$ gjc ralplan --help"];

	async run(): Promise<void> {
		await runBridgedRuntimeEndpoint("ralplan", this.argv);
	}
}
