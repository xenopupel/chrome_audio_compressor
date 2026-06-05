'use strict';

/**
 * Behavioral DSP tests — проверяют задачу, не код.
 * Каждый тест отвечает на вопрос: "работает ли компрессор правильно с точки зрения звука?"
 *
 * Запуск: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ─── Mock AudioWorklet environment ───────────────────────────────────────────

const SR = 48000;
global.sampleRate = SR;
global.AudioWorkletProcessor = class { constructor() {} };
let Processor;
global.registerProcessor = (_, cls) => { Processor = cls; };
require('../worklet/compressor-processor.js');

// ─── Signal helpers ───────────────────────────────────────────────────────────

const BLOCK = 128;

/** Синусоида заданной громкости (dBFS) и длины */
function sine(amplitudeDb, samples, freq = 1000) {
  const amp = Math.pow(10, amplitudeDb / 20);
  return Float32Array.from({ length: samples }, (_, i) =>
    amp * Math.sin(2 * Math.PI * freq * i / SR)
  );
}

function silence(n) {
  return new Float32Array(n);
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/** RMS уровень сигнала в dBFS */
function rmsDb(signal) {
  const rms = Math.sqrt(signal.reduce((s, x) => s + x * x, 0) / signal.length);
  return rms > 1e-10 ? 20 * Math.log10(rms) : -120;
}

/** Параметры компрессора (значения по умолчанию можно переопределить) */
function makeParams(overrides = {}) {
  const base = {
    threshold: -18, ratio: 3, attack: 0.05, release: 0.3,
    knee: 6, bypass: 0, margin: 8, adaptive: 0, // adaptive=0 by default in tests for predictability
  };
  const p = { ...base, ...overrides };
  return Object.fromEntries(Object.keys(p).map(k => [k, new Float32Array([p[k]])]));
}

/** Прогоняет моно-сигнал через процессор, возвращает левый канал */
function processSignal(inputMono, params) {
  const proc = new Processor();
  const output = new Float32Array(inputMono.length);

  for (let offset = 0; offset < inputMono.length; offset += BLOCK) {
    const len = Math.min(BLOCK, inputMono.length - offset);
    const inBlock = inputMono.slice(offset, offset + len);
    const inPad = len < BLOCK ? concat(inBlock, new Float32Array(BLOCK - len)) : inBlock;

    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[inPad, inPad]], [[outL, outR]], params);
    output.set(outL.subarray(0, len), offset);
  }

  return output;
}

// ─── Тесты ───────────────────────────────────────────────────────────────────

test('bypass: сигнал проходит без изменений при bypass=1', () => {
  const input = sine(-6, SR);
  const output = processSignal(input, makeParams({ bypass: 1 }));

  for (let i = 0; i < input.length; i++) {
    assert.ok(Math.abs(output[i] - input[i]) < 1e-6,
      `Sample ${i}: вход ${input[i].toFixed(4)}, выход ${output[i].toFixed(4)}`);
  }
});

test('тихий сигнал (диалог): ниже порога — компрессор не трогает', () => {
  // -30 dBFS, порог -18 dBFS — сигнал на 12 dB ниже, knee 6 dB → полностью вне компрессии
  const input = sine(-30, SR * 2);
  const output = processSignal(input, makeParams({ threshold: -18, ratio: 3, knee: 6 }));

  const warmup = Math.round(0.15 * SR); // ждём заполнения RMS-окна 100ms
  const inRms  = rmsDb(input.subarray(warmup));
  const outRms = rmsDb(output.subarray(warmup));
  const diff   = Math.abs(outRms - inRms);

  assert.ok(diff < 0.5,
    `Тихий диалог не должен компрессироваться. Вход: ${inRms.toFixed(1)} dB, выход: ${outRms.toFixed(1)} dB, разница: ${diff.toFixed(2)} dB`);
});

test('громкий сигнал (взрыв): выше порога — компрессор давит', () => {
  // -6 dBFS, порог -18 dBFS → 12 dB выше порога, ожидаем заметное ослабление
  const input = sine(-6, SR * 3);
  const output = processSignal(input, makeParams({ threshold: -18, ratio: 3, knee: 6 }));

  const settle = Math.round(0.5 * SR); // ждём установления
  const inRms  = rmsDb(input.subarray(settle));
  const outRms = rmsDb(output.subarray(settle));
  const gr     = inRms - outRms;

  // RMS синусоиды на ~3 dB ниже пика, поэтому overshoot относительно
  // threshold меньше чем кажется по пику. При -6 dBFS пике и threshold -18:
  // RMS входа ≈ -9 dBFS, overshoot = 9 dB → GR ≈ 3.6 dB (feedback топология).
  assert.ok(gr > 2.5,
    `Громкий сигнал должен компрессироваться. Gain reduction: ${gr.toFixed(1)} dB (ожидаем > 2.5 dB)`);
});

test('соотношение компрессии: более громкий сигнал давится сильнее (ratio 4:1)', () => {
  // Оба сигнала выше порога, но один громче — у него должно быть больше GR
  const params = makeParams({ threshold: -24, ratio: 4, knee: 2 });
  const settle = Math.round(0.6 * SR);

  const inputMed  = sine(-18, SR * 2); //  6 dB выше порога
  const inputLoud = sine(-12, SR * 2); // 12 dB выше порога

  const outMed  = processSignal(inputMed,  params);
  const outLoud = processSignal(inputLoud, params);

  const grMed  = rmsDb(inputMed.subarray(settle))  - rmsDb(outMed.subarray(settle));
  const grLoud = rmsDb(inputLoud.subarray(settle)) - rmsDb(outLoud.subarray(settle));

  assert.ok(grLoud > grMed,
    `Более громкий сигнал должен давиться сильнее. GR med: ${grMed.toFixed(1)} dB, GR loud: ${grLoud.toFixed(1)} dB`);
});

test('attack: компрессия нарастает со временем, не мгновенно', () => {
  // В начале сигнала (до заполнения RMS-окна и attack) GR почти нет
  // Через 3× attack + RMS-окно — GR должен заметно вырасти
  const input = sine(-6, SR * 2);
  const params = makeParams({ attack: 0.05, threshold: -18, ratio: 3 });
  const output = processSignal(input, params);

  // Первые 30ms — компрессия ещё не набрала силу
  const earlyOut = output.subarray(0, Math.round(0.03 * SR));
  const earlyIn  = input.subarray(0, earlyOut.length);

  // После 400ms — должна установиться
  const lateStart = Math.round(0.4 * SR);
  const lateOut   = output.subarray(lateStart, lateStart + Math.round(0.2 * SR));
  const lateIn    = input.subarray(lateStart, lateStart + lateOut.length);

  const grEarly = rmsDb(earlyIn) - rmsDb(earlyOut);
  const grLate  = rmsDb(lateIn)  - rmsDb(lateOut);

  assert.ok(grLate > grEarly + 2,
    `Компрессия должна нарастать. GR в начале: ${grEarly.toFixed(1)} dB, после установления: ${grLate.toFixed(1)} dB`);
});

test('release: после громкого звука тихий сигнал восстанавливается', () => {
  // Громкий взрыв → тихий диалог. Диалог в конце должен звучать тише,
  // чем в начале (когда компрессор ещё держит gain reduction от взрыва)
  const loud  = sine(-6,  Math.round(SR * 1.0)); // 1s взрыв
  const quiet = sine(-30, Math.round(SR * 2.0)); // 2s диалог
  const input = concat(loud, quiet);

  const params = makeParams({ release: 0.3, threshold: -18, ratio: 3 });
  const output = processSignal(input, params);

  const quietStart = loud.length;

  // Сразу после взрыва — компрессор ещё держит GR
  const earlyQuiet = output.subarray(quietStart, quietStart + Math.round(0.1 * SR));
  const earlyRef   = quiet.subarray(0, earlyQuiet.length);

  // Через 1.5s диалога — должен отпустить
  const lateOffset = Math.round(1.5 * SR);
  const lateQuiet  = output.subarray(quietStart + lateOffset, quietStart + lateOffset + Math.round(0.2 * SR));
  const lateRef    = quiet.subarray(lateOffset, lateOffset + lateQuiet.length);

  // "Gap" = разница между тем, что должно быть, и что есть (отрицательное = подавлено)
  const earlyGap = rmsDb(earlyQuiet) - rmsDb(earlyRef);
  const lateGap  = rmsDb(lateQuiet)  - rmsDb(lateRef);

  assert.ok(lateGap > earlyGap,
    `После взрыва диалог должен восстановиться. Gap сразу: ${earlyGap.toFixed(1)} dB, gap после release: ${lateGap.toFixed(1)} dB`);
});

test('RMS vs peak: короткий импульс (1ms) не вызывает длительной компрессии', () => {
  // Главное отличие от peak-компрессора: 1ms пик не должен давить следующий тихий звук.
  // Peak-компрессор среагировал бы на пик. RMS со 100ms окном — почти нет.
  const impulse     = Float32Array.from({ length: Math.round(0.001 * SR) }, () => 0.9);
  const afterQuiet  = sine(-30, Math.round(SR * 0.8));
  const input       = concat(impulse, afterQuiet);

  const params = makeParams({ threshold: -18, ratio: 3 });
  const output = processSignal(input, params);

  // Смотрим тихую часть через 50ms после импульса (даём устаканиться)
  const checkStart = impulse.length + Math.round(0.05 * SR);
  const checkLen   = Math.round(0.3 * SR);
  const outRms = rmsDb(output.subarray(checkStart, checkStart + checkLen));
  const inRms  = rmsDb(afterQuiet.subarray(Math.round(0.05 * SR), Math.round(0.05 * SR) + checkLen));

  assert.ok(Math.abs(outRms - inRms) < 3,
    `Короткий импульс не должен давить последующий тихий сигнал. Вход: ${inRms.toFixed(1)} dB, выход: ${outRms.toFixed(1)} dB`);
});

test('soft knee: сигнал у порога давится мягче, чем далеко выше порога', () => {
  // Прирост GR на 1 dB превышения должен быть меньше у края knee, чем далеко от него
  const threshold = -24;
  const knee      = 6; // half-knee = 3 dB
  const params    = makeParams({ threshold, knee, ratio: 4 });
  const settle    = Math.round(0.6 * SR);

  // Чуть выше порога (2 dB, внутри knee)
  const inputNear = sine(threshold + 2, SR * 2);
  // Далеко выше порога (12 dB, хорошо за knee)
  const inputFar  = sine(threshold + 12, SR * 2);

  const outNear = processSignal(inputNear, params);
  const outFar  = processSignal(inputFar,  params);

  const grNear = rmsDb(inputNear.subarray(settle)) - rmsDb(outNear.subarray(settle));
  const grFar  = rmsDb(inputFar.subarray(settle))  - rmsDb(outFar.subarray(settle));

  // GR на dB превышения: у порога должно быть меньше
  const grPerDbNear = grNear / 2;
  const grPerDbFar  = grFar  / 12;

  assert.ok(grPerDbFar > grPerDbNear,
    `Soft knee: у порога компрессия мягче. GR/dB у порога: ${grPerDbNear.toFixed(2)}, далеко: ${grPerDbFar.toFixed(2)}`);
});

// ─── Adaptive threshold tests ─────────────────────────────────────────────────

test('adaptive: floor tracker снижается при тихом сигнале', () => {
  // Кормим тихий сигнал (-30 dBFS) достаточно долго, чтобы floor опустился.
  // Потом проверяем, что порог стал ниже стартового -20 dBFS + margin 8 = -12 dBFS.
  const proc = new Processor();
  const quietInput = sine(-30, SR * 20); // 20 секунд тихого сигнала
  const params = makeParams({ adaptive: 1, margin: 8, ratio: 3 });

  // Прогоняем 20с без записи выхода — нас интересует только состояние floor
  for (let offset = 0; offset < quietInput.length; offset += BLOCK) {
    const len = Math.min(BLOCK, quietInput.length - offset);
    const inBlock = quietInput.slice(offset, offset + len);
    const inPad = len < BLOCK ? concat(inBlock, new Float32Array(BLOCK - len)) : inBlock;
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[inPad, inPad]], [[outL, outR]], params);
  }

  // Читаем внутренний floor через port-сообщение (нам нужно проверить что floor упал)
  // Косвенно: если floor упал к -30, то effective threshold = -30 + 8 = -22.
  // При тихом сигнале (-30 dBFS, RMS ≈ -33 dBFS) это ниже threshold → нет компрессии.
  // Значит выход ≈ вход.
  const checkInput = sine(-30, Math.round(SR * 1));
  const checkOutput = new Float32Array(checkInput.length);
  for (let offset = 0; offset < checkInput.length; offset += BLOCK) {
    const len = Math.min(BLOCK, checkInput.length - offset);
    const inBlock = checkInput.slice(offset, offset + len);
    const inPad = len < BLOCK ? concat(inBlock, new Float32Array(BLOCK - len)) : inBlock;
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[inPad, inPad]], [[outL, outR]], params);
    checkOutput.set(outL.subarray(0, len), offset);
  }

  const inRms  = rmsDb(checkInput.subarray(Math.round(0.1 * SR)));
  const outRms = rmsDb(checkOutput.subarray(Math.round(0.1 * SR)));
  const diff   = Math.abs(outRms - inRms);

  assert.ok(diff < 1,
    `После адаптации floor к тихому контенту, тихий сигнал не должен давиться. Разница: ${diff.toFixed(2)} dB`);
});

test('adaptive: одинаковый динамический диапазон при разной громкости плеера', () => {
  // Симулируем "плеер на 40%" (сигнал -10 dB тише) и "плеер на 80%".
  // После адаптации компрессор должен давить пики одинаково относительно диалога.

  function simulatePlayback(baseDb, durationS) {
    // Диалог (base) + взрывы (+15 dB над диалогом)
    const dialogue  = sine(baseDb,      Math.round(SR * durationS * 0.7));
    const explosion = sine(baseDb + 15, Math.round(SR * durationS * 0.3));
    return concat(dialogue, explosion);
  }

  const params = makeParams({ adaptive: 1, margin: 8, ratio: 3 });

  // Прогон при тихом плеере (базовый уровень -28 dBFS)
  function runAndMeasureGR(baseDb) {
    const proc   = new Processor();
    const warmup = simulatePlayback(baseDb, 30); // 30s для адаптации floor
    const test   = simulatePlayback(baseDb, 4);  // 4s для измерения

    for (let offset = 0; offset < warmup.length; offset += BLOCK) {
      const len = Math.min(BLOCK, warmup.length - offset);
      const inPad = new Float32Array(BLOCK);
      inPad.set(warmup.slice(offset, offset + len));
      proc.process([[inPad, inPad]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], params);
    }

    const outputTest = new Float32Array(test.length);
    for (let offset = 0; offset < test.length; offset += BLOCK) {
      const len = Math.min(BLOCK, test.length - offset);
      const inPad = new Float32Array(BLOCK);
      inPad.set(test.slice(offset, offset + len));
      const outL = new Float32Array(BLOCK);
      proc.process([[inPad, inPad]], [[outL, new Float32Array(BLOCK)]], params);
      outputTest.set(outL.subarray(0, len), offset);
    }

    // GR во время взрывной части (последние 30%)
    const explStart = Math.round(test.length * 0.7);
    return rmsDb(test.subarray(explStart)) - rmsDb(outputTest.subarray(explStart));
  }

  const grQuiet = runAndMeasureGR(-28); // тихий плеер
  const grLoud  = runAndMeasureGR(-14); // громкий плеер

  // GR должен быть примерно одинаковым (±3 dB) — компрессор адаптировался
  const diff = Math.abs(grQuiet - grLoud);
  assert.ok(diff < 3,
    `Адаптивный threshold: GR при тихом плеере ${grQuiet.toFixed(1)} dB, при громком ${grLoud.toFixed(1)} dB. Разница ${diff.toFixed(1)} dB (ожидаем < 3 dB)`);
});

test('adaptive: взрыв не сдвигает floor (floor tracker asymmetric)', () => {
  // Долгий тихий контент → floor адаптировался → короткий (5с) взрыв.
  // Floor не должен сильно подняться за 5с.
  const proc = new Processor();
  const params = makeParams({ adaptive: 1, margin: 8, ratio: 3, knee: 6 });

  // 30s тихого контента для адаптации
  const quiet = sine(-28, SR * 30);
  for (let offset = 0; offset < quiet.length; offset += BLOCK) {
    const len = Math.min(BLOCK, quiet.length - offset);
    const inPad = new Float32Array(BLOCK);
    inPad.set(quiet.slice(offset, offset + len));
    proc.process([[inPad, inPad]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], params);
  }

  // 5s взрыва
  const explosion = sine(-8, SR * 5);
  for (let offset = 0; offset < explosion.length; offset += BLOCK) {
    const len = Math.min(BLOCK, explosion.length - offset);
    const inPad = new Float32Array(BLOCK);
    inPad.set(explosion.slice(offset, offset + len));
    proc.process([[inPad, inPad]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], params);
  }

  // После взрыва — снова тихий сигнал. Должен компрессироваться так же как до взрыва (floor не уехал).
  const afterQuiet  = sine(-28, Math.round(SR * 2));
  const afterOutput = new Float32Array(afterQuiet.length);
  for (let offset = 0; offset < afterQuiet.length; offset += BLOCK) {
    const len = Math.min(BLOCK, afterQuiet.length - offset);
    const inPad = new Float32Array(BLOCK);
    inPad.set(afterQuiet.slice(offset, offset + len));
    const outL = new Float32Array(BLOCK);
    proc.process([[inPad, inPad]], [[outL, new Float32Array(BLOCK)]], params);
    afterOutput.set(outL.subarray(0, len), offset);
  }

  const settle  = Math.round(0.3 * SR);
  const inRms   = rmsDb(afterQuiet.subarray(settle));
  const outRms  = rmsDb(afterOutput.subarray(settle));
  const diff    = Math.abs(outRms - inRms);

  // Тихий сигнал после взрыва должен проходить без сильной компрессии — floor не поднялся
  assert.ok(diff < 2,
    `Взрыв не должен сдвинуть floor вверх. Тихий сигнал после взрыва: вход ${inRms.toFixed(1)} dB, выход ${outRms.toFixed(1)} dB, разница ${diff.toFixed(2)} dB`);
});
