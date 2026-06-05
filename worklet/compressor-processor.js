class CinemaCompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18,  minValue: -60,  maxValue: 0,    automationRate: 'k-rate' },
      { name: 'ratio',     defaultValue: 3,    minValue: 1,    maxValue: 20,   automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 0.05, minValue: 0.001,maxValue: 1,    automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 0.3,  minValue: 0.05, maxValue: 2,    automationRate: 'k-rate' },
      { name: 'knee',      defaultValue: 6,    minValue: 0,    maxValue: 24,   automationRate: 'k-rate' },
      { name: 'bypass',    defaultValue: 0,    minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();

    // RMS detection: 100ms window via O(1) circular buffer
    this._rmsWindowSamples = Math.round(0.1 * sampleRate);
    this._sqSum = 0;
    this._rmsBuffer = new Float32Array(this._rmsWindowSamples);
    this._rmsWritePos = 0;

    // Current gain state (feedback loop)
    this._gainDb = 0;
    this._gainLin = 1.0;

    // Program-dependent release: leaky integrator tracking signal density
    this._densityAccumulator = 0;
    this._densityDecay = Math.exp(-1 / (sampleRate * 2)); // 2-second time constant
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input.length || !input[0].length) return true;

    const bypass    = parameters.bypass[0];
    const threshold = parameters.threshold[0];
    const ratio     = parameters.ratio[0];
    const attackS   = parameters.attack[0];
    const releaseS  = parameters.release[0];
    const knee      = parameters.knee[0];

    if (bypass >= 0.5) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].set(input[ch < input.length ? ch : 0]);
      }
      return true;
    }

    const blockSize = input[0].length; // typically 128 samples

    // k-rate params are constant per block
    const attackCoeff  = Math.exp(-1 / (attackS  * sampleRate));
    const releaseCoeff = Math.exp(-1 / (releaseS * sampleRate));
    const halfKnee     = knee / 2;

    for (let i = 0; i < blockSize; i++) {
      // --- Feedback topology: apply current gain first, detect from output ---
      let monoIn = 0;
      for (let ch = 0; ch < input.length; ch++) monoIn += input[ch][i];
      monoIn /= input.length;

      const outputForDetection = monoIn * this._gainLin;

      // --- RMS detection (circular buffer, O(1)) ---
      const oldSq = this._rmsBuffer[this._rmsWritePos];
      const newSq = outputForDetection * outputForDetection;
      this._sqSum += newSq - oldSq;
      this._rmsBuffer[this._rmsWritePos] = newSq;
      this._rmsWritePos = (this._rmsWritePos + 1) % this._rmsWindowSamples;

      const rmsLin = Math.sqrt(Math.max(0, this._sqSum / this._rmsWindowSamples));
      const rmsDb  = rmsLin > 1e-10 ? 20 * Math.log10(rmsLin) : -120;

      // --- Gain computer with soft knee ---
      const overshoot = rmsDb - threshold;
      let gainReductionDb;

      if (overshoot <= -halfKnee) {
        gainReductionDb = 0;
      } else if (overshoot >= halfKnee) {
        gainReductionDb = overshoot * (1 - 1 / ratio);
      } else {
        // Quadratic blend through the knee (Zölzer DAFX formula)
        const kneeFactor = (overshoot + halfKnee) / knee;
        gainReductionDb  = kneeFactor * kneeFactor * overshoot * (1 - 1 / ratio);
      }

      const targetGainDb = -gainReductionDb;

      // --- Program-dependent release ---
      // Leaky integrator: accumulates when GR > 1dB, decays over 2s
      this._densityAccumulator =
        this._densityAccumulator * this._densityDecay + (gainReductionDb > 1 ? 1 : 0);

      const densityNorm = Math.min(1, this._densityAccumulator / (sampleRate * 0.5));
      const releaseMultiplier = 1.0 + densityNorm * 2.0; // 1x (sparse) to 3x (dense)

      // Raise releaseCoeff to a fractional power to slow it proportionally
      const effRelCoeff = Math.pow(releaseCoeff, 1 / releaseMultiplier);

      // --- Gain ballistics ---
      if (targetGainDb < this._gainDb) {
        this._gainDb = attackCoeff  * this._gainDb + (1 - attackCoeff)  * targetGainDb;
      } else {
        this._gainDb = effRelCoeff  * this._gainDb + (1 - effRelCoeff)  * targetGainDb;
      }

      this._gainLin = Math.pow(10, this._gainDb / 20);

      // --- Apply gain to all output channels ---
      // Makeup gain is applied by GainNode in content_script (unity reference here)
      for (let ch = 0; ch < output.length; ch++) {
        output[ch][i] = input[ch < input.length ? ch : 0][i] * this._gainLin;
      }
    }

    return true;
  }
}

registerProcessor('cinema-compressor', CinemaCompressorProcessor);
