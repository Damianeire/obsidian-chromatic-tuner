/**
 * Pitch detection using the McLeod Pitch Method (MPM) — "A Smarter Way to Find Pitch",
 * McLeod & Wyvill, 2005.
 *
 * The normalised square difference function (NSDF) is built from an FFT-based
 * autocorrelation, so a frame costs O(n log n) and can comfortably run on every
 * animation frame.
 */

export interface PitchResult {
	frequency: number;
	/** 0–1: how periodic the frame is. Sustained notes score near 1, noise scores low. */
	clarity: number;
}

export interface PitchRange {
	minFrequency: number;
	maxFrequency: number;
}

// A peak must reach this fraction of the tallest NSDF peak to be picked. Taking the first such
// peak (the shortest period) rather than simply the tallest one avoids octave-down errors.
const PEAK_THRESHOLD = 0.9;
// Frames less periodic than this are treated as noise.
const MIN_CLARITY = 0.8;

export function rootMeanSquare(samples: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / samples.length);
}

export class PitchDetector {
	private readonly frameSize: number;
	private readonly sampleRate: number;
	private readonly fftSize: number;
	private readonly frame: Float64Array;
	private readonly real: Float64Array;
	private readonly imag: Float64Array;
	private readonly nsdf: Float64Array;
	private readonly cosTable: Float64Array;
	private readonly sinTable: Float64Array;
	private readonly bitReversed: Uint32Array;

	constructor(frameSize: number, sampleRate: number) {
		this.frameSize = frameSize;
		this.sampleRate = sampleRate;

		// Zero-padding to at least twice the frame stops the circular autocorrelation wrapping around.
		let fftSize = 1;
		while (fftSize < frameSize * 2) fftSize <<= 1;
		this.fftSize = fftSize;

		this.frame = new Float64Array(frameSize);
		this.real = new Float64Array(fftSize);
		this.imag = new Float64Array(fftSize);
		this.nsdf = new Float64Array(frameSize);

		this.cosTable = new Float64Array(fftSize / 2);
		this.sinTable = new Float64Array(fftSize / 2);
		for (let i = 0; i < fftSize / 2; i++) {
			this.cosTable[i] = Math.cos((2 * Math.PI * i) / fftSize);
			this.sinTable[i] = Math.sin((2 * Math.PI * i) / fftSize);
		}

		const bits = Math.log2(fftSize);
		this.bitReversed = new Uint32Array(fftSize);
		for (let i = 0; i < fftSize; i++) {
			let reversed = 0;
			for (let b = 0, x = i; b < bits; b++, x >>= 1) reversed = (reversed << 1) | (x & 1);
			this.bitReversed[i] = reversed;
		}
	}

	detect(samples: Float32Array, range: PitchRange): PitchResult | null {
		const n = this.frameSize;
		const { frame, real, imag, nsdf } = this;

		let mean = 0;
		for (let i = 0; i < n; i++) mean += samples[i];
		mean /= n;
		for (let i = 0; i < n; i++) frame[i] = samples[i] - mean;

		// Autocorrelation r(τ) = Σ x[j]·x[j+τ]: transform, take the power spectrum, transform again.
		// The power spectrum is real and even, so the second forward transform is fftSize × r(τ).
		real.fill(0);
		imag.fill(0);
		real.set(frame);
		this.transform();
		for (let i = 0; i < this.fftSize; i++) {
			real[i] = real[i] * real[i] + imag[i] * imag[i];
			imag[i] = 0;
		}
		this.transform();

		const minLag = Math.max(2, Math.floor(this.sampleRate / range.maxFrequency));
		const maxLag = Math.min(Math.floor(n / 2), Math.ceil(this.sampleRate / range.minFrequency));
		if (minLag >= maxLag) return null;

		// m'(τ) = Σ (x[j]² + x[j+τ]²) over the overlapping samples, updated incrementally.
		let energy = 0;
		for (let i = 0; i < n; i++) energy += frame[i] * frame[i];
		energy *= 2;
		if (energy === 0) return null;

		nsdf[0] = 1;
		for (let lag = 1; lag <= maxLag + 1; lag++) {
			energy -= frame[lag - 1] * frame[lag - 1] + frame[n - lag] * frame[n - lag];
			nsdf[lag] = energy > 0 ? (2 * real[lag]) / this.fftSize / energy : 0;
		}

		// Skip the positive lobe around τ = 0, then take the maximum of each later positive lobe.
		let lag = 1;
		while (lag <= maxLag && nsdf[lag] > 0) lag++;

		const peaks: number[] = [];
		let highest = 0;
		while (lag <= maxLag) {
			while (lag <= maxLag && nsdf[lag] <= 0) lag++;
			let peak = -1;
			while (lag <= maxLag && nsdf[lag] > 0) {
				if (peak === -1 || nsdf[lag] > nsdf[peak]) peak = lag;
				lag++;
			}
			if (peak >= minLag && peak < maxLag) {
				peaks.push(peak);
				highest = Math.max(highest, nsdf[peak]);
			}
		}

		const cutoff = highest * PEAK_THRESHOLD;
		const chosen = peaks.find((p) => nsdf[p] >= cutoff);
		if (chosen === undefined) return null;

		// Parabolic interpolation around the chosen peak gives a sub-sample period.
		const a = nsdf[chosen - 1];
		const b = nsdf[chosen];
		const c = nsdf[chosen + 1];
		const curvature = a - 2 * b + c;
		const shift = curvature < 0 ? (a - c) / (2 * curvature) : 0;
		const clarity = b - ((a - c) * shift) / 4;
		if (clarity < MIN_CLARITY) return null;

		const frequency = this.sampleRate / (chosen + shift);
		if (frequency < range.minFrequency || frequency > range.maxFrequency) return null;
		return { frequency, clarity: Math.min(clarity, 1) };
	}

	/** In-place iterative radix-2 FFT of (real, imag). */
	private transform() {
		const { real, imag, fftSize, cosTable, sinTable, bitReversed } = this;

		for (let i = 0; i < fftSize; i++) {
			const j = bitReversed[i];
			if (i < j) {
				let t = real[i];
				real[i] = real[j];
				real[j] = t;
				t = imag[i];
				imag[i] = imag[j];
				imag[j] = t;
			}
		}

		for (let size = 2; size <= fftSize; size <<= 1) {
			const half = size >> 1;
			const step = fftSize / size;
			for (let start = 0; start < fftSize; start += size) {
				for (let k = 0; k < half; k++) {
					const cos = cosTable[k * step];
					const sin = sinTable[k * step];
					const p = start + k;
					const q = p + half;
					const tr = real[q] * cos + imag[q] * sin;
					const ti = imag[q] * cos - real[q] * sin;
					real[q] = real[p] - tr;
					imag[q] = imag[p] - ti;
					real[p] += tr;
					imag[p] += ti;
				}
			}
		}
	}
}
