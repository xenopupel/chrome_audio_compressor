class CinemaCompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18,  minValue: -60,  maxValue: 0,    automationRate: 'k-rate' },
      { name: 'ratio',     defaultValue: 3,    minValue: 1,    maxValue: 20,   automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 0.05, minValue: 0.001,maxValue: 1,    automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 0.3,  minValue: 0.05, maxValue: 2,    automationRate: 'k-rate' },
      { name: 'knee',      defaultValue: 6,    minValue: 0,    maxValue: 24,   automationRate: 'k-rate' },
      { name: 'bypass',    defaultValue: 0,    minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
      { name: 'margin',    defaultValue: 8,    minValue: 0,    maxValue: 24,   automationRate: 'k-rate' },
      { name: 'adaptive',  defaultValue: 1,    minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();

    // Fast RMS detection: 100ms window via O(1) circular buffer
    this._rmsWindowSamples = Math.round(0.1 * sampleRate);
    this._sqSum = 0;
    this._rmsBuffer = new Float32Array(this._rmsWindowSamples);
    this._rmsWritePos = 0;

    // Gain state (feedback loop)
    this._gainDb = 0;
    this._gainLin = 1.0;

    // Program-dependent release
    this._densityAccumulator = 0;
    this._densityDecay = Math.exp(-1 / (sampleRate * 2));

    // Floor tracker: follows quiet moments (player volume), ignores loud peaks.
    // Adapts downward quickly (6s) when signal gets quieter.
    // Drifts upward very slowly (45s) — brief explosions barely move it.
    this._floorDb = -20; // sensible start: typical mid-volume content
    this._floorDownCoeff = Math.exp(-1 / (6  * sampleRate));
    this._floorUpCoeff   = Math.exp(-1 / (45 * sampleRate));

    // Port reporting: send floor value to content_script every 2s
    this._reportCounter = 0;
    this._reportEvery   = Math.round(sampleRate * 2);
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];

    if (!input || !input.length || !input[0].length) return true;

    const bypass   = parameters.bypass[0];
    const ratio    = parameters.ratio[0];
    const attackS  = parameters.attack[0];
    const releaseS = parameters.release[0];
    const knee     = parameters.knee[0];
    const adaptive = parameters.adaptive[0];
    const margin   = parameters.margin[0];

    // Effective threshold: auto (floor + margin) or manual
    const thresholdEffective = adaptive >= 0.5
      ? Math.max(-55, this._floorDb + margin)
      : parameters.threshold[0];

    if (bypass >= 0.5) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].set(input[ch < input.length ? ch : 0]);
      }
      return true;
    }

    const blockSize    = input[0].length;
    const attackCoeff  = Math.exp(-1 / (attackS  * sampleRate));
    const releaseCoeff = Math.exp(-1 / (releaseS * sampleRate));
    const halfKnee     = knee / 2;

    let lastRmsDb = -120;

    for (let i = 0; i < blockSize; i++) {
      // Feedback topology: apply current gain, detect from output
      let monoIn = 0;
      for (let ch = 0; ch < input.length; ch++) monoIn += input[ch][i];
      monoIn /= input.length;

      const outputForDetection = monoIn * this._gainLin;

      // Fast RMS (circular buffer, O(1))
      const oldSq = this._rmsBuffer[this._rmsWritePos];
      const newSq = outputForDetection * outputForDetection;
      this._sqSum += newSq - oldSq;
      this._rmsBuffer[this._rmsWritePos] = newSq;
      this._rmsWritePos = (this._rmsWritePos + 1) % this._rmsWindowSamples;

      const rmsLin = Math.sqrt(Math.max(0, this._sqSum / this._rmsWindowSamples));
      lastRmsDb    = rmsLin > 1e-10 ? 20 * Math.log10(rmsLin) : -120;

      // Gain computer (soft knee)
      const overshoot = lastRmsDb - thresholdEffective;
      let gainReductionDb;

      if (overshoot <= -halfKnee) {
        gainReductionDb = 0;
      } else if (overshoot >= halfKnee) {
        gainReductionDb = overshoot * (1 - 1 / ratio);
      } else {
        const kneeFactor = (overshoot + halfKnee) / knee;
        gainReductionDb  = kneeFactor * kneeFactor * overshoot * (1 - 1 / ratio);
      }

      const targetGainDb = -gainReductionDb;

      // Program-dependent release
      this._densityAccumulator =
        this._densityAccumulator * this._densityDecay + (gainReductionDb > 1 ? 1 : 0);
      const densityNorm       = Math.min(1, this._densityAccumulator / (sampleRate * 0.5));
      const releaseMultiplier = 1.0 + densityNorm * 2.0;
      const effRelCoeff       = Math.pow(releaseCoeff, 1 / releaseMultiplier);

      // Ballistics
      if (targetGainDb < this._gainDb) {
        this._gainDb = attackCoeff * this._gainDb + (1 - attackCoeff) * targetGainDb;
      } else {
        this._gainDb = effRelCoeff * this._gainDb + (1 - effRelCoeff) * targetGainDb;
      }

      this._gainLin = Math.pow(10, this._gainDb / 20);

      for (let ch = 0; ch < output.length; ch++) {
        output[ch][i] = input[ch < input.length ? ch : 0][i] * this._gainLin;
      }
    }

    // Floor tracker update (once per block, using last block's RMS)
    // Ignore silence — don't let paused video pull floor to -120
    const FLOOR_MIN = -50;
    if (lastRmsDb > FLOOR_MIN) {
      if (lastRmsDb < this._floorDb) {
        // Signal quieter than floor: adapt down quickly (player turned down, quiet scene)
        const c = Math.pow(this._floorDownCoeff, blockSize);
        this._floorDb = c * this._floorDb + (1 - c) * lastRmsDb;
      } else {
        // Signal louder than floor: drift up very slowly (mostly stays put during explosions)
        const c = Math.pow(this._floorUpCoeff, blockSize);
        this._floorDb = c * this._floorDb + (1 - c) * lastRmsDb;
      }
    }

    // Report floor + effective threshold to content_script every 2s
    this._reportCounter += blockSize;
    if (this._reportCounter >= this._reportEvery) {
      this._reportCounter = 0;
      this.port?.postMessage({ type: 'floor', floorDb: this._floorDb, thresholdDb: thresholdEffective });
    }

    return true;
  }
}

registerProcessor('cinema-compressor', CinemaCompressorProcessor);
