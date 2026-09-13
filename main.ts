import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { TUNER_ICON, TunerView, VIEW_TYPE_TUNER } from "./src/TunerView";

export interface ChromaticTunerSettings {
	instrumentId: string;
	/** Empty string means the system default input. */
	deviceId: string;
	/** Frequency of A4 in Hz. */
	referencePitch: number;
	inTuneCents: number;
	noiseGateDb: number;
}

const DEFAULT_SETTINGS: ChromaticTunerSettings = {
	instrumentId: "chromatic",
	deviceId: "",
	referencePitch: 440,
	inTuneCents: 5,
	noiseGateDb: -55,
};

export default class ChromaticTunerPlugin extends Plugin {
	settings: ChromaticTunerSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_TUNER, (leaf) => new TunerView(leaf, this));
		this.addRibbonIcon(TUNER_ICON, "Open tuner", () => this.activateView());
		this.addCommand({
			id: "open",
			name: "Open tuner",
			callback: () => this.activateView(),
		});
		this.addSettingTab(new ChromaticTunerSettingTab(this.app, this));
	}

	// Opening the tuner on purpose starts listening straight away. A tuner panel restored with
	// the workspace when Obsidian launches stays stopped, so the mic is never grabbed unasked.
	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_TUNER)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_TUNER, active: true });
		}
		await workspace.revealLeaf(leaf);
		if (leaf.view instanceof TunerView) void leaf.view.start();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ChromaticTunerSettingTab extends PluginSettingTab {
	plugin: ChromaticTunerPlugin;

	constructor(app: App, plugin: ChromaticTunerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Reference pitch (A4)")
			.setDesc("In Hz. 440 is standard; some orchestras tune to 442.")
			.addSlider((slider) => {
				slider.setLimits(415, 466, 1).setValue(this.plugin.settings.referencePitch).setDynamicTooltip();
				slider.onChange(async (value) => {
					this.plugin.settings.referencePitch = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("In-tune range")
			.setDesc("How close to the target a note must be, in cents, to show green.")
			.addSlider((slider) => {
				slider.setLimits(1, 10, 1).setValue(this.plugin.settings.inTuneCents).setDynamicTooltip();
				slider.onChange(async (value) => {
					this.plugin.settings.inTuneCents = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Noise gate")
			.setDesc(
				"Sounds quieter than this (dBFS) are ignored. Lower it if quiet notes aren't picked up; raise it in a noisy room. The marker on the tuner's input meter shows this level."
			)
			.addSlider((slider) => {
				slider.setLimits(-80, -20, 1).setValue(this.plugin.settings.noiseGateDb).setDynamicTooltip();
				slider.onChange(async (value) => {
					this.plugin.settings.noiseGateDb = value;
					await this.plugin.saveSettings();
				});
			});
	}
}
