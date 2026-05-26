import { Command } from "@gajae-code/utils/cli";
import { runBridgedRuntimeEndpoint } from "./gjc-runtime-bridge";

export default class Ultragoal extends Command {
	static description = "Run private GJC Ultragoal workflow commands";
	static strict = false;
	static examples = ["$ gjc ultragoal status --json"];

	async run(): Promise<void> {
		await runBridgedRuntimeEndpoint("ultragoal", this.argv);
	}
}
