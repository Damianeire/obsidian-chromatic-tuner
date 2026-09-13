export interface Instrument {
	id: string;
	name: string;
	/** Open strings from lowest to highest, in scientific pitch notation. Empty for chromatic mode. */
	strings: string[];
}

export const INSTRUMENTS: Instrument[] = [
	{ id: "chromatic", name: "Chromatic", strings: [] },
	{ id: "tenor-banjo", name: "Tenor banjo (CGDA)", strings: ["C3", "G3", "D4", "A4"] },
	{ id: "irish-tenor-banjo", name: "Irish tenor banjo (GDAE)", strings: ["G2", "D3", "A3", "E4"] },
	{ id: "guitar", name: "Guitar (EADGBE)", strings: ["E2", "A2", "D3", "G3", "B3", "E4"] },
	{ id: "bass", name: "Bass (EADG)", strings: ["E1", "A1", "D2", "G2"] },
	{ id: "cello", name: "Cello (CGDA)", strings: ["C2", "G2", "D3", "A3"] },
	{ id: "mandolin", name: "Mandolin (GDAE)", strings: ["G3", "D4", "A4", "E5"] },
	{ id: "violin", name: "Violin (GDAE)", strings: ["G3", "D4", "A4", "E5"] },
];

export function getInstrument(id: string): Instrument {
	return INSTRUMENTS.find((instrument) => instrument.id === id) ?? INSTRUMENTS[0];
}
