// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { formatTime } from '../src/index.js';
import { buildUi, LOADING_STEPS, SPEEDS } from '../src/ui.js';

describe('formatTime', () => {
  it('writes a run time the way a run time is written', () => {
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(7.5)).toBe('0:07.500');
    expect(formatTime(61.234)).toBe('1:01.234');
    expect(formatTime(600)).toBe('10:00.000');
  });

  it('survives nothing to show', () => {
    expect(formatTime(NaN)).toBe('0:00.000');
    expect(formatTime(Infinity)).toBe('0:00.000');
    expect(formatTime(-2.5)).toBe('-0:02.500');
  });
});

describe('buildUi', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.append(container);
  });

  it('puts everything the player drives inside the container', () => {
    const ui = buildUi(container);
    expect(container.querySelector('.mtvp')).toBe(ui.root);
    expect(ui.canvas.tagName).toBe('CANVAS');
    expect(ui.root.contains(ui.canvas)).toBe(true);
    expect(ui.root.contains(ui.bar)).toBe(true);
    expect(ui.root.contains(ui.hud.panel)).toBe(true);
    expect(ui.root.contains(ui.loading.panel)).toBe(true);
  });

  it('has one loading step per stage', () => {
    const ui = buildUi(container);
    expect([...ui.loading.steps.keys()]).toEqual([...LOADING_STEPS]);
  });

  it('puts the timer on top, the speed in the middle and the keys below', () => {
    const ui = buildUi(container);
    expect(ui.hud.timer.parentElement?.className).toBe('mtvp-hud-top');
    expect(ui.hud.split.parentElement?.className).toBe('mtvp-hud-top');
    expect(ui.hud.speed.parentElement?.className).toBe('mtvp-hud-middle');
    expect(ui.hud.crosshair.parentElement?.className).toBe('mtvp-hud-middle');
    // the crosshair comes first, so the speed reads under it
    expect(ui.hud.crosshair.nextElementSibling).toBe(ui.hud.speed);
    expect(ui.hud.keys.get('jump')?.parentElement?.parentElement?.className).toBe('mtvp-hud-bottom');
  });

  it('shows the speed as a number on its own', () => {
    const ui = buildUi(container);
    expect(ui.hud.speed.textContent).toBe('0');
    expect(ui.hud.speed.querySelector('span')).toBeNull();
  });

  it('has a key for every input it shows', () => {
    const ui = buildUi(container);
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'duck']) {
      expect(ui.hud.keys.get(key)).toBeTruthy();
    }
    expect(ui.hud.keys.get('jump')!.textContent).toBe('SPACE');
  });

  it('runs the speed from very slow to fast, starting at normal', () => {
    const ui = buildUi(container);
    expect(SPEEDS[0]).toBe(0.05);
    expect(SPEEDS.at(-1)).toBe(4);
    expect(SPEEDS).toContain(1);
    expect(ui.speedRange.min).toBe('0');
    expect(ui.speedRange.max).toBe(String(SPEEDS.length - 1));
    expect(SPEEDS[Number(ui.speedRange.value)]).toBe(1);
    expect(ui.speedValue.textContent).toBe('1x');
  });

  it('offers the cameras', () => {
    const ui = buildUi(container);
    expect(Array.from(ui.cameraSelect.options, (o) => o.value)).toEqual([
      'firstperson',
      'thirdperson',
      'free',
    ]);
  });

  it('adds its styles once, however many players a page holds', () => {
    buildUi(container);
    const second = document.createElement('div');
    document.body.append(second);
    buildUi(second);
    expect(document.querySelectorAll('#mtv-player-styles')).toHaveLength(1);
    expect(document.querySelectorAll('.mtvp')).toHaveLength(2);
  });

  it('starts with the settings closed and the loading screen up', () => {
    const ui = buildUi(container);
    expect(ui.menu.classList.contains('mtvp-open')).toBe(false);
    expect(ui.loading.panel.classList.contains('mtvp-gone')).toBe(false);
  });
});
