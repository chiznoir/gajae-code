import { Command } from "@gajae-code/utils/cli";
import { runBridgedRuntimeEndpoint } from "./gjc-runtime-bridge";

export default class State extends Command {
	static description = "Read or update private GJC workflow state";
	static strict = false;
	static examples = ['$ gjc state read --input \'{"mode":"team"}\' --json'];

	async run(): Promise<void> {
		await runBridgedRuntimeEndpoint("state", this.argv);
	}
}
