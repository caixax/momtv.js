/**
 * The player's own styles, kept as one string so a page needs nothing but the
 * script: no stylesheet to add, no font to fetch, nothing that a strict
 * content policy would block.
 *
 * Every rule is under the player's own class, so dropping it into a page
 * cannot change anything around it.
 */
export const CSS = `
.mtvp {
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
  --mtvp-accent: #f0a93b;
}
.mtvp * { box-sizing: border-box; }
.mtvp canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

/* the run readout, in the corner the game puts it */
.mtvp-hud {
  position: absolute;
  left: 16px;
  top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .9);
}
.mtvp-timer {
  font-size: 34px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: .5px;
  line-height: 1;
}
.mtvp-timer.mtvp-finished { color: var(--mtvp-accent); }
.mtvp-split { font-size: 13px; opacity: .75; font-variant-numeric: tabular-nums; min-height: 18px; }
.mtvp-speed {
  font-size: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.mtvp-speed span { font-size: 12px; font-weight: 400; opacity: .7; margin-left: 4px; }
.mtvp-detail { font-size: 12px; opacity: .65; font-variant-numeric: tabular-nums; white-space: pre; }

/* the keys the runner pressed */
.mtvp-keys { display: grid; grid-template-columns: repeat(3, 26px); gap: 3px; margin-top: 4px; }
.mtvp-key {
  height: 22px;
  border: 1px solid rgba(255, 255, 255, .25);
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  background: rgba(0, 0, 0, .35);
  opacity: .45;
}
.mtvp-key.mtvp-on { background: var(--mtvp-accent); border-color: var(--mtvp-accent); color: #10151b; opacity: 1; }
.mtvp-key.mtvp-wide { grid-column: span 3; }

/* the bar along the bottom */
.mtvp-bar {
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
.mtvp.mtvp-idle .mtvp-bar { opacity: 0; pointer-events: none; }
.mtvp-seek {
  position: relative;
  height: 16px;
  display: flex;
  align-items: center;
  cursor: pointer;
}
.mtvp-seek-track {
  position: relative;
  height: 4px;
  width: 100%;
  border-radius: 2px;
  background: rgba(255, 255, 255, .22);
  overflow: hidden;
}
.mtvp-seek-fill { position: absolute; inset: 0 auto 0 0; background: var(--mtvp-accent); width: 0%; }
.mtvp-seek-zone { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255, 255, 255, .55); }
.mtvp-seek-head {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: var(--mtvp-accent);
  transform: scale(0);
  transition: transform .12s ease;
}
.mtvp-seek:hover .mtvp-seek-head, .mtvp-seek.mtvp-dragging .mtvp-seek-head { transform: scale(1); }
.mtvp-row { display: flex; align-items: center; gap: 8px; }
.mtvp-btn {
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
.mtvp-btn:hover { background: rgba(255, 255, 255, .12); }
.mtvp-btn.mtvp-icon { width: 32px; height: 30px; display: grid; place-items: center; font-size: 15px; }
.mtvp-time { font-variant-numeric: tabular-nums; opacity: .8; min-width: 104px; }
.mtvp-grow { flex: 1; }
.mtvp-select {
  appearance: none;
  background: rgba(255, 255, 255, .1);
  border: 1px solid rgba(255, 255, 255, .16);
  color: inherit;
  font: inherit;
  padding: 4px 7px;
  border-radius: 4px;
  cursor: pointer;
}
.mtvp-select:hover { background: rgba(255, 255, 255, .18); }

/* the settings flyout */
.mtvp-menu {
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
.mtvp-menu.mtvp-open { display: flex; }
.mtvp-menu h4 { margin: 0 0 2px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .55; font-weight: 600; }
.mtvp-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mtvp-field label { opacity: .85; }
.mtvp-field input[type=range] { width: 108px; accent-color: var(--mtvp-accent); }
.mtvp-field input[type=checkbox] { accent-color: var(--mtvp-accent); }

/* the loading screen */
.mtvp-load {
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
.mtvp-load.mtvp-gone { opacity: 0; pointer-events: none; }
.mtvp-load-title { font-size: 17px; font-weight: 600; letter-spacing: .02em; }
.mtvp-load-sub { font-size: 12px; opacity: .6; min-height: 16px; font-variant-numeric: tabular-nums; }
.mtvp-load-track {
  width: min(380px, 70%);
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, .14);
  overflow: hidden;
}
.mtvp-load-fill {
  height: 100%;
  width: 0%;
  background: var(--mtvp-accent);
  transition: width .2s ease;
}
.mtvp-load-steps { display: flex; gap: 14px; font-size: 11px; opacity: .55; flex-wrap: wrap; justify-content: center; }
.mtvp-load-step.mtvp-done { opacity: 1; color: var(--mtvp-accent); }
.mtvp-load-step.mtvp-active { opacity: 1; }
.mtvp-error { color: #ff8a7a; font-size: 13px; max-width: 420px; }
`;
