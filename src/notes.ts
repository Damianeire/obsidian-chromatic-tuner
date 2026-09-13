const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const NATURAL_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI note 69 is A4, which sounds at the reference pitch. */
export function midiToFrequency(midi: number, referencePitch: number): number {
	return referencePitch * Math.pow(2, (midi - 69) / 12);
}

/** Fractional MIDI note number, e.g. 69.1 is A4 ten cents sharp. */
export function frequencyToMidi(frequency: number, referencePitch: number): number {
	return 69 + 12 * Math.log2(frequency / referencePitch);
}

export function centsBetween(frequency: number, target: number): number {
	return 1200 * Math.log2(frequency / target);
}

export function noteName(midi: number): { name: string; octave: number } {
	const rounded = Math.round(midi);
	return { name: NOTE_NAMES[((rounded % 12) + 12) % 12], octave: Math.floor(rounded / 12) - 1 };
}

/** Parses scientific pitch notation such as "E2", "F#3" or "Bb4" into a MIDI note number. */
export function parseNote(note: string): number {
	const match = note.match(/^([A-G])([#♯b♭]?)(-?\d)$/);
	if (!match) throw new Error(`Invalid note: ${note}`);
	const accidental = match[2] === "#" || match[2] === "♯" ? 1 : match[2] ? -1 : 0;
	return (parseInt(match[3], 10) + 1) * 12 + NATURAL_SEMITONES[match[1]] + accidental;
}
