/**
 * The player's chrome: a loading screen, a bar along the bottom and the run
 * readout in the corner.
 *
 * It is plain DOM, built once and then only updated, so the player can be
 * dropped into any page without a framework.
 */
import { CSS } from './styles.js';

/** Identifier of the stylesheet the player adds to a page. */
const STYLE_ID = 'mtv-player-styles';

/** Puts the stylesheet in the document once, however many players there are. */
function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).append(style);
}

/** Every part of the chrome the player updates. */
export interface PlayerUi {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  loading: {
    panel: HTMLElement;
    title: HTMLElement;
    detail: HTMLElement;
    fill: HTMLElement;
    steps: Map<string, HTMLElement>;
  };
  hud: {
    panel: HTMLElement;
    timer: HTMLElement;
    split: HTMLElement;
    speed: HTMLElement;
    detail: HTMLElement;
    keys: Map<string, HTMLElement>;
  };
  bar: HTMLElement;
  playButton: HTMLButtonElement;
  seek: HTMLElement;
  seekFill: HTMLElement;
  seekHead: HTMLElement;
  seekZones: HTMLElement;
  time: HTMLElement;
  speedSelect: HTMLSelectElement;
  cameraSelect: HTMLSelectElement;
  settingsButton: HTMLButtonElement;
  fullscreenButton: HTMLButtonElement;
  menu: HTMLElement;
  settings: {
    fov: HTMLInputElement;
    hud: HTMLInputElement;
    props: HTMLInputElement;
    sky: HTMLInputElement;
    loop: HTMLInputElement;
  };
}

/** The stages the loading screen shows, in order. */
export const LOADING_STEPS = ['replay', 'map', 'materials', 'props', 'sky'] as const;

/** Builds the chrome inside a container and returns the parts to update. */
export function buildUi(container: HTMLElement): PlayerUi {
  const doc = container.ownerDocument;
  ensureStyles(doc);

  /** Makes an element with a class and optional text. */
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const root = el('div', 'mtvp');
  const canvas = el('canvas');
  root.append(canvas);

  // --- the run readout ---
  const hudPanel = el('div', 'mtvp-hud');
  const timer = el('div', 'mtvp-timer', '0:00.000');
  const split = el('div', 'mtvp-split', '');
  const speed = el('div', 'mtvp-speed');
  speed.innerHTML = '0<span>u/s</span>';
  const detail = el('div', 'mtvp-detail', '');
  const keysBox = el('div', 'mtvp-keys');
  const keys = new Map<string, HTMLElement>();
  const addKey = (name: string, label: string, wide = false): void => {
    const node = el('div', `mtvp-key${wide ? ' mtvp-wide' : ''}`, label);
    keys.set(name, node);
    keysBox.append(node);
  };
  // a keypad: strafes and forward on top, then back, then the two big ones
  addKey('spacer1', '');
  addKey('forward', 'W');
  addKey('spacer2', '');
  addKey('left', 'A');
  addKey('back', 'S');
  addKey('right', 'D');
  addKey('duck', 'CTRL', true);
  addKey('jump', 'SPACE', true);
  keys.get('spacer1')!.style.visibility = 'hidden';
  keys.get('spacer2')!.style.visibility = 'hidden';
  hudPanel.append(timer, split, speed, detail, keysBox);
  root.append(hudPanel);

  // --- the bar ---
  const bar = el('div', 'mtvp-bar');
  const seek = el('div', 'mtvp-seek');
  const seekTrack = el('div', 'mtvp-seek-track');
  const seekFill = el('div', 'mtvp-seek-fill');
  const seekZones = el('div');
  const seekHead = el('div', 'mtvp-seek-head');
  seekTrack.append(seekFill, seekZones);
  seek.append(seekTrack, seekHead);

  const row = el('div', 'mtvp-row');
  const playButton = el('button', 'mtvp-btn mtvp-icon', '▶');
  playButton.title = 'Play or pause (space)';
  const time = el('div', 'mtvp-time', '0:00.000 / 0:00.000');
  const grow = el('div', 'mtvp-grow');
  const speedSelect = el('select', 'mtvp-select');
  for (const value of [0.1, 0.25, 0.5, 1, 2, 4]) {
    const option = el('option', undefined, `${value}x`);
    option.value = String(value);
    speedSelect.append(option);
  }
  speedSelect.value = '1';
  speedSelect.title = 'Playback speed';
  const cameraSelect = el('select', 'mtvp-select');
  for (const [value, label] of [
    ['firstperson', 'First person'],
    ['thirdperson', 'Third person'],
    ['free', 'Free camera'],
  ] as const) {
    const option = el('option', undefined, label);
    option.value = value;
    cameraSelect.append(option);
  }
  cameraSelect.value = 'firstperson';
  cameraSelect.title = 'Camera';
  const settingsButton = el('button', 'mtvp-btn mtvp-icon', '⚙');
  settingsButton.title = 'Settings';
  const fullscreenButton = el('button', 'mtvp-btn mtvp-icon', '⛶');
  fullscreenButton.title = 'Fullscreen (f)';
  row.append(playButton, time, grow, speedSelect, cameraSelect, settingsButton, fullscreenButton);
  bar.append(seek, row);
  root.append(bar);

  // --- the settings flyout ---
  const menu = el('div', 'mtvp-menu');
  const field = (label: string, input: HTMLElement): HTMLElement => {
    const wrap = el('div', 'mtvp-field');
    wrap.append(el('label', undefined, label), input);
    return wrap;
  };
  const fov = el('input');
  fov.type = 'range';
  fov.min = '60';
  fov.max = '130';
  fov.step = '1';
  fov.value = '90';
  const toggle = (checked: boolean): HTMLInputElement => {
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    return input;
  };
  const hudToggle = toggle(true);
  const propsToggle = toggle(true);
  const skyToggle = toggle(true);
  const loopToggle = toggle(false);
  menu.append(
    el('h4', undefined, 'View'),
    field('Field of view', fov),
    field('Run readout', hudToggle),
    el('h4', undefined, 'Scene'),
    field('Props', propsToggle),
    field('Sky', skyToggle),
    el('h4', undefined, 'Playback'),
    field('Loop', loopToggle),
  );
  root.append(menu);

  // --- the loading screen ---
  const loadPanel = el('div', 'mtvp-load');
  const loadTitle = el('div', 'mtvp-load-title', 'Loading replay');
  const loadDetail = el('div', 'mtvp-load-sub', '');
  const loadTrack = el('div', 'mtvp-load-track');
  const loadFill = el('div', 'mtvp-load-fill');
  loadTrack.append(loadFill);
  const stepsRow = el('div', 'mtvp-load-steps');
  const steps = new Map<string, HTMLElement>();
  for (const name of LOADING_STEPS) {
    const node = el('div', 'mtvp-load-step', name);
    steps.set(name, node);
    stepsRow.append(node);
  }
  loadPanel.append(loadTitle, loadTrack, loadDetail, stepsRow);
  root.append(loadPanel);

  container.append(root);

  return {
    root,
    canvas,
    loading: { panel: loadPanel, title: loadTitle, detail: loadDetail, fill: loadFill, steps },
    hud: { panel: hudPanel, timer, split, speed, detail, keys },
    bar,
    playButton,
    seek,
    seekFill,
    seekHead,
    seekZones,
    time,
    speedSelect,
    cameraSelect,
    settingsButton,
    fullscreenButton,
    menu,
    settings: { fov, hud: hudToggle, props: propsToggle, sky: skyToggle, loop: loopToggle },
  };
}
