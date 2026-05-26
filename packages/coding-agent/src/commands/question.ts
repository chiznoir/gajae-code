import { Command } from "@gajae-code/utils/cli";
import { runBridgedRuntimeEndpoint } from "./gjc-runtime-bridge";

export default class Question extends Command {
	static description = "Ask a blocking private runtime question through the GJC bridge";
	static strict = false;
	static examples = ["$ gjc question --input '<json>' --json"];

	async run(): Promise<void> {
		await runBridgedRuntimeEndpoint("question", this.argv);
	}
}
