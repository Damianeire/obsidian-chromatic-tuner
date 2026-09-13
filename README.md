# obsidian-chromatic-tuner

A chromatic tuner for Obsidian, with instrument modes and microphone input selection.

## Features

- **Instruments**: Chromatic, Tenor banjo (CGDA), Irish tenor banjo (GDAE), Guitar (EADGBE), Bass (EADG), Cello (CGDA), Mandolin (GDAE), Violin (GDAE).
- **Input selection**: pick which microphone to listen on. The choice is remembered, and if that mic isn't connected the tuner falls back to the system default until it is.
- **String modes**: detects which string you're tuning automatically, or tap a string to lock onto it (handy when a string is badly out and would otherwise read as its neighbour).
- **Needle and cents readout**: green inside the in-tune range, yellow when close, red when off.
- **Input level meter** with a noise gate marker, so you can see the selected mic is actually hearing you.
- Settings for reference pitch (A4 = 415–466 Hz), in-tune range and noise gate.

## Usage

Click the waveform icon in the ribbon, or run **Chromatic Tuner: Open tuner** from the command palette. The tuner opens in the right sidebar and starts listening. Press **Stop** (or close the panel) to release the microphone.

### Choosing a microphone

The laptop's built-in mic is usually the best choice:

- Noise-cancelling earbuds and headsets process their mics for speech, which can gate out or smear sustained notes.
- On macOS, using AirPods (or other Bluetooth headphones) as a mic switches them into a low-quality call mode for as long as the tuner is listening.

The tuner turns off the browser's own echo cancellation, noise suppression and auto-gain, but it can't turn off processing that happens inside a headset.

If input names show as "Microphone 1, 2…", start the tuner once: names are only available after microphone access is granted. On macOS, Obsidian needs permission under **System Settings → Privacy & Security → Microphone**.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check and production build
```

To install manually, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/chromatic-tuner/`, then enable **Chromatic Tuner** under Settings → Community plugins.

Pitch detection uses the McLeod Pitch Method (normalised square difference function computed with an FFT-based autocorrelation) in [src/pitch.ts](src/pitch.ts).
