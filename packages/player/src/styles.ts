/**
 * The player's own styles, kept as one string so a page needs nothing but the
 * script: no stylesheet to add, no font to fetch, nothing that a strict
 * content policy would block.
 *
 * Every rule is under the player's own class, so dropping it into a page
 * cannot change anything around it.
 */
export const CSS = `
.momtvp {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-height: 240px;
  overflow: hidden;
  background: #0b0f14;
  color: #e8eef5;
  font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  user-select: none;
  --momtvp-accent: #f0a93b;
}
.momtvp * { box-sizing: border-box; }
.momtvp canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

/* the run readout, laid out the way the game lays it out */
.momtvp-hud { position: absolute; inset: 0; pointer-events: none; }
.momtvp-hud.momtvp-hidden { display: none; }

/* timer and stage, across the top */
.momtvp-hud-top {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  text-shadow: 0 2px 4px rgba(0, 0, 0, .85);
}
.momtvp-timer {
  font-size: 38px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: .5px;
  line-height: 1;
}
.momtvp-timer.momtvp-finished { color: var(--momtvp-accent); }
.momtvp-split {
  margin-top: 4px;
  font-size: 14px;
  opacity: .8;
  font-variant-numeric: tabular-nums;
  min-height: 18px;
  letter-spacing: .04em;
}

/* the crosshair, and the speed just under it */
.momtvp-hud-middle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.momtvp-cross { position: relative; width: 11px; height: 11px; opacity: .8; }
.momtvp-cross::before, .momtvp-cross::after {
  content: '';
  position: absolute;
  background: #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, .9);
}
.momtvp-cross::before { left: 50%; top: 0; width: 1px; height: 100%; margin-left: -.5px; }
.momtvp-cross::after { top: 50%; left: 0; height: 1px; width: 100%; margin-top: -.5px; }
.momtvp-speed {
  margin-top: 26px;
  font-size: 40px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: #fff;
  text-shadow: 0 2px 5px rgba(0, 0, 0, .85);
  transition: color .09s linear;
}
.momtvp-speed.momtvp-faster { color: #5fa8ff; }
.momtvp-speed.momtvp-slower { color: #ff5a52; }

/* the keys the runner pressed, along the bottom */
.momtvp-hud-bottom {
  position: absolute;
  bottom: 96px;
  left: 50%;
  transform: translateX(-50%);
}
.momtvp-keys { display: grid; grid-template-columns: repeat(3, 34px); gap: 4px; justify-content: center; }
.momtvp-key {
  height: 28px;
  border: 1px solid rgba(255, 255, 255, .3);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  background: rgba(0, 0, 0, .4);
  opacity: .5;
}
.momtvp-key.momtvp-on { background: var(--momtvp-accent); border-color: var(--momtvp-accent); color: #10151b; opacity: 1; }
.momtvp-key.momtvp-wide { grid-column: span 3; }

/* the small print, out of the way in a corner */
.momtvp-detail {
  position: absolute;
  left: 14px;
  top: 14px;
  font-size: 12px;
  opacity: .55;
  font-variant-numeric: tabular-nums;
  white-space: pre;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .9);
}

/* the bar along the bottom */
.momtvp-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 24px 12px 10px;
  background: linear-gradient(to top, rgba(6, 9, 13, .92), rgba(6, 9, 13, 0));
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: opacity .25s ease;
}
.momtvp.momtvp-idle .momtvp-bar { opacity: 0; pointer-events: none; }
.momtvp-seek {
  position: relative;
  height: 16px;
  display: flex;
  align-items: center;
  cursor: pointer;
}
.momtvp-seek-track {
  position: relative;
  height: 4px;
  width: 100%;
  border-radius: 2px;
  background: rgba(255, 255, 255, .22);
  overflow: hidden;
}
.momtvp-seek-fill { position: absolute; inset: 0 auto 0 0; background: var(--momtvp-accent); width: 0%; }
.momtvp-seek-zone { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255, 255, 255, .55); }
.momtvp-seek-head {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: var(--momtvp-accent);
  transform: scale(0);
  transition: transform .12s ease;
}
.momtvp-seek:hover .momtvp-seek-head, .momtvp-seek.momtvp-dragging .momtvp-seek-head { transform: scale(1); }
.momtvp-row { display: flex; align-items: center; gap: 8px; }
.momtvp-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  line-height: 1;
}
.momtvp-btn:hover { background: rgba(255, 255, 255, .12); }
.momtvp-btn.momtvp-icon { width: 32px; height: 30px; display: grid; place-items: center; font-size: 15px; }
.momtvp-time { font-variant-numeric: tabular-nums; opacity: .8; min-width: 104px; }
.momtvp-grow { flex: 1; }
.momtvp-select {
  appearance: none;
  background: rgba(255, 255, 255, .1);
  border: 1px solid rgba(255, 255, 255, .16);
  color: inherit;
  font: inherit;
  padding: 4px 7px;
  border-radius: 4px;
  cursor: pointer;
}
.momtvp-select:hover { background: rgba(255, 255, 255, .18); }
.momtvp-speedbox { display: flex; align-items: center; gap: 7px; }
.momtvp-speedbox input[type=range] {
  width: 104px;
  accent-color: var(--momtvp-accent);
  cursor: pointer;
}
.momtvp-speedvalue {
  font-variant-numeric: tabular-nums;
  min-width: 44px;
  text-align: right;
  opacity: .85;
  cursor: pointer;
}

/* the settings flyout */
.momtvp-menu {
  position: absolute;
  right: 12px;
  bottom: 56px;
  width: 232px;
  padding: 10px;
  border-radius: 6px;
  background: rgba(12, 17, 23, .96);
  border: 1px solid rgba(255, 255, 255, .12);
  display: none;
  flex-direction: column;
  gap: 8px;
}
.momtvp-menu.momtvp-open { display: flex; }
.momtvp-menu h4 { margin: 0 0 2px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .55; font-weight: 600; }
.momtvp-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.momtvp-field label { opacity: .85; }
.momtvp-field input[type=range] { width: 108px; accent-color: var(--momtvp-accent); }
.momtvp-field input[type=checkbox] { accent-color: var(--momtvp-accent); }

/* the loading screen */
.momtvp-load {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  background: radial-gradient(120% 120% at 50% 0%, #16202b 0%, #0b0f14 70%);
  text-align: center;
  transition: opacity .35s ease;
}
.momtvp-load.momtvp-gone { opacity: 0; pointer-events: none; }
.momtvp-load-title { font-size: 17px; font-weight: 600; letter-spacing: .02em; }
.momtvp-load-sub { font-size: 12px; opacity: .6; min-height: 16px; font-variant-numeric: tabular-nums; }
.momtvp-load-track {
  width: min(380px, 70%);
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, .14);
  overflow: hidden;
}
.momtvp-load-fill {
  height: 100%;
  width: 0%;
  background: var(--momtvp-accent);
  transition: width .2s ease;
}
.momtvp-load-steps { display: flex; gap: 14px; font-size: 11px; opacity: .55; flex-wrap: wrap; justify-content: center; }
.momtvp-load-step.momtvp-done { opacity: 1; color: var(--momtvp-accent); }
.momtvp-load-step.momtvp-active { opacity: 1; }
.momtvp-error { color: #ff8a7a; font-size: 13px; max-width: 420px; }
`;
