# Cinema Compressor

Chrome-расширение для динамической компрессии звука при просмотре фильмов и сериалов. Решает проблему резкого перепада громкости: взрывы и музыка больше не заглушают диалоги.

Алгоритм — «glue»-компрессор в стиле SSL Bus Compressor: RMS-детекция (не peak), soft knee, feedback-топология, program-dependent release.

## Установка

1. Открыть `chrome://extensions`
2. Включить **Developer mode** (переключатель справа вверху)
3. Нажать **Load unpacked** → выбрать папку с расширением

## Использование

1. Открыть любую страницу с видео (YouTube и т.п.)
2. Нажать на иконку расширения в тулбаре
3. Включить тумблер
4. Подобрать интенсивность слайдером (Soft → Aggressive)

Для тонкой настройки — раскрыть секцию **Advanced**: порог, соотношение, attack/release, makeup gain.

## Тест на YouTube

1. Открыть любое видео на [youtube.com](https://youtube.com)
2. Нажать Play
3. Открыть расширение → включить → поставить интенсивность на максимум
4. Статус-бар должен показать **Active on 1 element**
5. Переключать тумблер on/off — компрессия должна слышно включаться/выключаться

Если статус показывает **No media detected** — попробуй нажать на страницу (клик нужен для разблокировки AudioContext браузером) и снова открыть расширение.

## Параметры по умолчанию

| Параметр  | Значение |
|-----------|----------|
| Threshold | −18 dB   |
| Ratio     | 3 : 1    |
| Attack    | 50 ms    |
| Release   | 300 ms   |
| Makeup    | +4 dB    |
| Knee      | 6 dB     |

## Структура проекта

```
manifest.json                — Manifest V3
background.js                — service worker, хранит состояние
content_script.js            — перехват <video>/<audio>, Web Audio граф
popup.html / popup.js        — UI расширения
styles/popup.css
worklet/
  compressor-processor.js   — DSP: AudioWorkletProcessor
icons/
```

## Ограничения Phase 1

- Работает только с медиа внутри браузера
- Сайты без CORS-заголовков на медиафайлы пропускаются (элемент продолжает играть без компрессии)
- Netflix/Disney+ требуют дополнительной проверки
