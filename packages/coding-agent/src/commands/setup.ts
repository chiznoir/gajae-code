/**
 * Install dependencies for optional features.
 */
import { Args, Command, Flags, renderCommandHelp } from "@gajae-code/utils/cli";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { initTheme } from "../modes/theme/theme";

const COMPONENTS: SetupComponent[] = ["defaults", "python", "stt"];

export default class Setup extends Command {
	static description = "Install dependencies for optional features";

	static args = {
		component: Args.string({
			description: "Component to install",
			required: false,
			options: COMPONENTS,
		}),
	};

	static flags = {
		check: Flags.boolean({ char: "c", description: "Check if dependencies are installed" }),
		force: Flags.boolean({ char: "f", description: "Overwrite existing default definition files" }),
		json: Flags.boolean({ description: "Output status as JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Setup);
		if (!args.component) {
			renderCommandHelp("gjc", "setup", Setup);
			return;
		}
		const cmd: SetupCommandArgs = {
			component: args.component as SetupComponent,
			flags: {
				json: flags.json,
				check: flags.check,
				force: flags.force,
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
