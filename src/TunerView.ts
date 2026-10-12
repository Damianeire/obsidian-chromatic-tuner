import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type ChromaticTunerPlugin from "../main";
import { getInstrument, INSTRUMENTS } from "./instruments";
import { centsBetween, frequencyToMidi, midiToFrequency, noteName, parseNote } from "./notes";
import { PitchDetector, rootMeanSquare, type PitchRange } from "./pitch";

export const VIEW_TYPE_TUNER = "chromatic-tuner";
export const TUNER_ICON = "audio-waveform";

const CHROMATIC_RANGE: PitchRange = { minFrequency: 27, maxFrequency: 2100 };
// How far outside an instrument's open strings a note can be and still be picked up, in semitones.
const RANGE_BELOW_LOWEST = 7;
const RANGE_ABOVE_HIGHEST = 24;

// Keep showing the last reading this long after the note dies away.
const HOLD_MS = 1500;
// The median of this many recent frames (~150 ms at 60 fps) steadies the reading.
const HISTORY_FRAMES = 9;
// A frame this far from the current reading is only believed once several in a row agree,
// which rejects one-off octave glitches while still following a newly played note promptly.
const JUMP_CENTS = 60;
const JUMP_CONFIRM_FRAMES = 3;
const NEEDLE_EASING = 0.3;
const CLOSE_CENTS = 15;
const METER_FLOOR_DB = -80;
const CENTS_TICKS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50];

function median(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatCents(cents: number): string {
	const rounded = Math.round(cents);
	if (rounded === 0) return "0 ¢";
	return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} ¢`;
}

function errorName(err: unknown): string {
	return typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
}

function describeMicError(err: unknown): string {
	switch (errorName(err)) {
		case "NotAllowedError":
		case "SecurityError":
			return "Microphone access was blocked. On macOS, allow Obsidian under System Settings → Privacy & Security → Microphone, then restart Obsidian.";
		case "NotFoundError":
			return "No microphone was found.";
		case "NotReadableError":
			return "The microphone couldn't be opened — another app may be using it.";
		default:
			return `Couldn't start the microphone: ${err instanceof Error ? err.message : String(err)}`;
	}
}

function audioConstraints(deviceId: string): MediaStreamConstraints {
	return {
		audio: {
			deviceId: deviceId ? { exact: deviceId } : undefined,
			// Voice processing is tuned for speech: it gates, smears and rides the level of
			// sustained notes, which is exactly what a tuner needs to hear cleanly.
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
		},
	};
}

export class TunerView extends ItemView {
	private plugin: ChromaticTunerPlugin;

	private stream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private analyser: AnalyserNode | null = null;
	private detector: PitchDetector | null = null;
	private samples: Float32Array | null = null;
	private frameWindow: Window | null = null;
	private frameHandle: number | null = null;
	private starting = false;
	// Bumped on every start and stop, so a slow permission prompt can't revive a stopped tuner.
	private startToken = 0;

	private stringMidis: number[] = [];
	private range: PitchRange = CHROMATIC_RANGE;
	private lockedString: number | null = null;
	private history: number[] = [];
	private pending: number[] = [];
	private lastHeardAt = 0;
	private displayCents: number | null = null;

	private instrumentSelect: HTMLSelectElement;
	private deviceSelect: HTMLSelectElement;
	private deviceHintEl: HTMLElement;
	private displayEl: HTMLElement;
	private noteEl: HTMLElement;
	private octaveEl: HTMLElement;
	private centsEl: HTMLElement;
	private meterEl: HTMLElement;
	private frequencyEl: HTMLElement;
	private stringsEl: HTMLElement;
	private stringButtons: HTMLButtonElement[] = [];
	private hintEl: HTMLElement;
	private levelFillEl: HTMLElement;
	private levelGateEl: HTMLElement;
	private toggleButton: HTMLButtonElement;
	private statusEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: ChromaticTunerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_TUNER;
	}

	getDisplayText() {
		return "Tuner";
	}

	getIcon() {
		return TUNER_ICON;
	}

	async onOpen() {
		this.build();
		this.applyInstrument();
		this.renderLevel(-Infinity);
		this.renderRunning();
		this.clearReading();
		void this.refreshDevices();

		const mediaDevices = navigator.mediaDevices;
		if (mediaDevices) {
			const onDeviceChange = () => void this.refreshDevices();
			mediaDevices.addEventListener("devicechange", onDeviceChange);
			this.register(() => mediaDevices.removeEventListener("devicechange", onDeviceChange));
		}
	}

	async onClose() {
		this.stop();
	}

	async start() {
		if (this.stream || this.starting) return;
		if (!navigator.mediaDevices?.getUserMedia) {
			this.setStatus("This device doesn't give Obsidian access to a microphone.");
			return;
		}

		const token = ++this.startToken;
		this.starting = true;
		this.setStatus("");
		this.renderRunning();
		this.clearReading();

		let stream: MediaStream | null = null;
		let context: AudioContext | null = null;
		try {
			stream = await this.openStream();
			context = new AudioContext();
			if (context.state === "suspended") await context.resume();
			if (token !== this.startToken) {
				stream.getTracks().forEach((track) => track.stop());
				void context.close();
				return;
			}

			const analyser = context.createAnalyser();
			analyser.fftSize = context.sampleRate > 50000 ? 8192 : 4096;
			// Deliberately not connected to the destination: listen only, never play the mic back.
			const source = context.createMediaStreamSource(stream);
			source.connect(analyser);

			this.stream = stream;
			this.audioContext = context;
			this.source = source;
			this.analyser = analyser;
			this.samples = new Float32Array(analyser.fftSize);
			this.detector = new PitchDetector(analyser.fftSize, context.sampleRate);
			this.frameWindow = this.contentEl.win;
			this.frameHandle = this.frameWindow.requestAnimationFrame(this.onFrame);
		} catch (err) {
			stream?.getTracks().forEach((track) => track.stop());
			void context?.close();
			if (token === this.startToken) this.setStatus(describeMicError(err));
		} finally {
			if (token === this.startToken) {
				this.starting = false;
				this.renderRunning();
				this.clearReading();
			}
		}

		// Input names are only exposed once microphone access has been granted.
		if (this.stream) void this.refreshDevices();
	}

	stop() {
		this.startToken++;
		this.starting = false;
		if (this.frameWindow && this.frameHandle !== null) this.frameWindow.cancelAnimationFrame(this.frameHandle);
		this.frameWindow = null;
		this.frameHandle = null;

		this.stream?.getTracks().forEach((track) => track.stop());
		void this.audioContext?.close();
		this.stream = null;
		this.audioContext = null;
		this.source = null;
		this.analyser = null;
		this.detector = null;
		this.samples = null;

		this.renderLevel(-Infinity);
		this.renderRunning();
		this.clearReading();
	}

	private async openStream(): Promise<MediaStream> {
		const deviceId = this.plugin.settings.deviceId;
		try {
			return await navigator.mediaDevices.getUserMedia(audioConstraints(deviceId));
		} catch (err) {
			const name = errorName(err);
			if (!deviceId || (name !== "OverconstrainedError" && name !== "NotFoundError")) throw err;
			// Keep the saved choice so it's picked up again when that mic is plugged back in.
			new Notice("The selected input isn't connected — using the system default microphone.");
			return navigator.mediaDevices.getUserMedia(audioConstraints(""));
		}
	}

	private build() {
		const root = this.contentEl;
		root.empty();
		root.addClass("ct-view");

		// --- Instrument and input pickers ---
		const controls = root.createDiv({ cls: "ct-controls" });

		const instrumentField = controls.createEl("label", { cls: "ct-field" });
		instrumentField.createSpan({ cls: "ct-field-label", text: "Instrument" });
		this.instrumentSelect = instrumentField.createEl("select", { cls: "dropdown" });
		INSTRUMENTS.forEach((instrument) =>
			this.instrumentSelect.createEl("option", { value: instrument.id, text: instrument.name })
		);

		const deviceField = controls.createEl("label", { cls: "ct-field" });
		deviceField.createSpan({ cls: "ct-field-label", text: "Input" });
		this.deviceSelect = deviceField.createEl("select", { cls: "dropdown" });
		this.deviceHintEl = deviceField.createSpan({ cls: "ct-field-hint" });

		// --- Note, cents and needle ---
		this.displayEl = root.createDiv({ cls: "ct-display" });
		const noteRow = this.displayEl.createDiv({ cls: "ct-note-row" });
		this.noteEl = noteRow.createSpan({ cls: "ct-note" });
		this.octaveEl = noteRow.createSpan({ cls: "ct-octave" });
		this.centsEl = this.displayEl.createDiv({ cls: "ct-cents" });

		this.meterEl = this.displayEl.createDiv({ cls: "ct-meter" });
		this.meterEl.createDiv({ cls: "ct-meter-zone" });
		CENTS_TICKS.forEach((cents) => {
			const tick = this.meterEl.createDiv({ cls: "ct-tick" });
			if (cents === 0) tick.addClass("is-center");
			else if (cents % 50 === 0) tick.addClass("is-major");
			tick.setCssProps({ "--ct-pos": `${cents + 50}%` });
		});
		this.meterEl.createDiv({ cls: "ct-needle" });

		const labels = this.displayEl.createDiv({ cls: "ct-meter-labels" });
		labels.createSpan({ text: "♭ flat" });
		labels.createSpan({ text: "sharp ♯" });
		this.frequencyEl = this.displayEl.createDiv({ cls: "ct-frequency" });

		// --- Strings (instrument modes only) ---
		this.stringsEl = root.createDiv({ cls: "ct-strings" });
		this.hintEl = root.createDiv({ cls: "ct-hint" });

		// --- Input level and start/stop ---
		const footer = root.createDiv({ cls: "ct-footer" });
		const level = footer.createDiv({ cls: "ct-level", attr: { "aria-label": "Input level" } });
		this.levelFillEl = level.createDiv({ cls: "ct-level-fill" });
		this.levelGateEl = level.createDiv({ cls: "ct-level-gate" });
		this.toggleButton = footer.createEl("button", { cls: "ct-toggle" });
		this.statusEl = root.createDiv({ cls: "ct-status" });

		// --- Wire events ---
		this.instrumentSelect.addEventListener("change", () => {
			void this.onInstrumentChange();
		});

		this.deviceSelect.addEventListener("change", () => {
			void this.onDeviceChange();
		});

		this.toggleButton.addEventListener("click", () => {
			if (this.stream) this.stop();
			else void this.start();
		});
	}

	private async onInstrumentChange() {
		this.plugin.settings.instrumentId = this.instrumentSelect.value;
		this.lockedString = null;
		this.applyInstrument();
		await this.plugin.saveSettings();
	}

	private async onDeviceChange() {
		this.plugin.settings.deviceId = this.deviceSelect.value;
		await this.plugin.saveSettings();
		if (this.stream || this.starting) {
			this.stop();
			await this.start();
		}
	}

	private applyInstrument() {
		const instrument = getInstrument(this.plugin.settings.instrumentId);
		this.instrumentSelect.value = instrument.id;
		this.stringMidis = instrument.strings.map((note) => parseNote(note));

		if (this.stringMidis.length) {
			const lowest = Math.min(...this.stringMidis);
			const highest = Math.max(...this.stringMidis);
			// The range only needs to be roughly right, so it ignores the reference pitch.
			this.range = {
				minFrequency: midiToFrequency(lowest - RANGE_BELOW_LOWEST, 440),
				maxFrequency: midiToFrequency(highest + RANGE_ABOVE_HIGHEST, 440),
			};
		} else {
			this.range = CHROMATIC_RANGE;
		}

		this.stringsEl.empty();
		this.stringButtons = this.stringMidis.map((midi, index) => {
			const { name, octave } = noteName(midi);
			const button = this.stringsEl.createEl("button", { cls: "ct-string" });
			button.createSpan({ text: name });
			button.createEl("sub", { text: String(octave) });
			button.addEventListener("click", () => {
				this.lockedString = this.lockedString === index ? null : index;
				this.renderHint();
				if (this.history.length) this.renderReading(false);
				else this.updateStringButtons(null);
			});
			return button;
		});
		this.stringsEl.toggle(this.stringMidis.length > 0);

		this.renderHint();
		if (this.history.length) this.renderReading(false);
		else this.clearReading();
	}

	private readonly onFrame = () => {
		const { analyser, detector, samples, frameWindow } = this;
		if (!analyser || !detector || !samples || !frameWindow) return;

		analyser.getFloatTimeDomainData(samples);
		const rms = rootMeanSquare(samples);
		const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
		this.renderLevel(db);

		const now = performance.now();
		const pitch = db >= this.plugin.settings.noiseGateDb ? detector.detect(samples, this.range) : null;
		if (pitch) {
			this.pushFrequency(pitch.frequency);
			this.lastHeardAt = now;
		}

		if (this.history.length && now - this.lastHeardAt > HOLD_MS) this.clearReading();
		else if (this.history.length) this.renderReading(pitch === null);

		this.frameHandle = frameWindow.requestAnimationFrame(this.onFrame);
	};

	private pushFrequency(frequency: number) {
		if (this.history.length && Math.abs(centsBetween(frequency, median(this.history))) > JUMP_CENTS) {
			this.pending.push(frequency);
			if (this.pending.length >= JUMP_CONFIRM_FRAMES) {
				this.history = this.pending;
				this.pending = [];
				this.displayCents = null;
			}
			return;
		}
		this.pending = [];
		this.history.push(frequency);
		if (this.history.length > HISTORY_FRAMES) this.history.shift();
	}

	private renderReading(stale: boolean) {
		const settings = this.plugin.settings;
		const frequency = median(this.history);
		const detectedMidi = frequencyToMidi(frequency, settings.referencePitch);

		let targetMidi: number;
		let stringIndex: number | null = null;
		if (this.stringMidis.length) {
			stringIndex = this.lockedString ?? this.nearestString(detectedMidi);
			targetMidi = this.stringMidis[stringIndex];
		} else {
			targetMidi = Math.round(detectedMidi);
		}

		const target = midiToFrequency(targetMidi, settings.referencePitch);
		const cents = centsBetween(frequency, target);
		this.displayCents =
			this.displayCents === null ? cents : this.displayCents + (cents - this.displayCents) * NEEDLE_EASING;
		const shown = this.displayCents;
		const distance = Math.abs(shown);

		const { name, octave } = noteName(targetMidi);
		this.noteEl.setText(name);
		this.octaveEl.setText(String(octave));
		this.centsEl.setText(formatCents(shown));

		let frequencyText = `${frequency.toFixed(1)} Hz`;
		if (stringIndex !== null) {
			frequencyText += ` → ${target.toFixed(1)} Hz`;
			if (Math.abs(cents) > 50) {
				const heard = noteName(detectedMidi);
				frequencyText += ` · hearing ${heard.name}${heard.octave}`;
			}
		}
		this.frequencyEl.setText(frequencyText);

		this.meterEl.setCssProps({
			"--ct-cents": String(Math.max(-50, Math.min(50, shown))),
			"--ct-tolerance": String(settings.inTuneCents),
		});
		this.displayEl.removeClass("is-idle");
		this.displayEl.toggleClass("is-stale", stale);
		this.displayEl.toggleClass("is-in-tune", distance <= settings.inTuneCents);
		this.displayEl.toggleClass("is-close", distance > settings.inTuneCents && distance <= CLOSE_CENTS);
		this.displayEl.toggleClass("is-off", distance > CLOSE_CENTS);

		this.updateStringButtons(stringIndex);
	}

	private clearReading() {
		this.history = [];
		this.pending = [];
		this.displayCents = null;

		this.displayEl.removeClass("is-stale", "is-in-tune", "is-close", "is-off");
		this.displayEl.addClass("is-idle");
		this.noteEl.setText("–");
		this.octaveEl.setText("");
		this.centsEl.setText("");
		this.frequencyEl.setText(this.stream ? "Listening…" : this.starting ? "" : "Press Start to tune");
		this.meterEl.setCssProps({
			"--ct-cents": "0",
			"--ct-tolerance": String(this.plugin.settings.inTuneCents),
		});
		this.updateStringButtons(null);
	}

	private nearestString(midi: number): number {
		let best = 0;
		this.stringMidis.forEach((stringMidi, index) => {
			if (Math.abs(stringMidi - midi) < Math.abs(this.stringMidis[best] - midi)) best = index;
		});
		return best;
	}

	private updateStringButtons(activeIndex: number | null) {
		this.stringButtons.forEach((button, index) => {
			button.toggleClass("is-active", index === activeIndex);
			button.toggleClass("is-locked", index === this.lockedString);
		});
	}

	private renderHint() {
		if (!this.stringMidis.length) {
			this.hintEl.setText("");
			return;
		}
		if (this.lockedString === null) {
			this.hintEl.setText("Detecting the string automatically — tap one to lock onto it.");
		} else {
			const { name, octave } = noteName(this.stringMidis[this.lockedString]);
			this.hintEl.setText(`Locked to ${name}${octave}. Tap it again to go back to automatic.`);
		}
	}

	private renderLevel(db: number) {
		const gate = this.plugin.settings.noiseGateDb;
		const toPercent = (value: number) =>
			`${Math.min(Math.max((value - METER_FLOOR_DB) / -METER_FLOOR_DB, 0), 1) * 100}%`;
		this.levelFillEl.setCssProps({ "--ct-level": toPercent(db) });
		this.levelFillEl.toggleClass("is-gated", db < gate);
		this.levelGateEl.setCssProps({ "--ct-gate": toPercent(gate) });
	}

	private renderRunning() {
		const running = this.stream !== null;
		this.toggleButton.setText(this.starting ? "Starting…" : running ? "Stop" : "Start");
		this.toggleButton.disabled = this.starting;
		this.toggleButton.toggleClass("mod-cta", !running);
	}

	private setStatus(message: string) {
		this.statusEl.setText(message);
	}

	private async refreshDevices() {
		const mediaDevices = navigator.mediaDevices;
		if (!mediaDevices?.enumerateDevices) return;

		let inputs: MediaDeviceInfo[];
		try {
			// "default" and "communications" are aliases Chromium adds for whichever real input the OS picks.
			inputs = (await mediaDevices.enumerateDevices()).filter(
				(device) =>
					device.kind === "audioinput" &&
					device.deviceId !== "" &&
					device.deviceId !== "default" &&
					device.deviceId !== "communications"
			);
		} catch {
			return;
		}

		const saved = this.plugin.settings.deviceId;
		const select = this.deviceSelect;
		select.empty();
		select.createEl("option", { value: "", text: "System default" });
		inputs.forEach((device, index) =>
			select.createEl("option", { value: device.deviceId, text: device.label || `Microphone ${index + 1}` })
		);
		if (saved && !inputs.some((device) => device.deviceId === saved)) {
			select.createEl("option", { value: saved, text: "Saved input (not connected)" });
		}
		select.value = saved;

		const unnamed = inputs.length === 0 || inputs.every((device) => !device.label);
		this.deviceHintEl.setText(unnamed && !this.stream ? "Start the tuner once to see input names." : "");
	}
}
