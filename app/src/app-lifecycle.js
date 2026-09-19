// PixelLyrics app lifecycle states for tray residency (M5.2 tray).
// running | hidden | releasing | exited
'use strict';

function createAppLifecycle() {
  let state = 'running';
  let lyricsPaused = false;

  return {
    getState() {
      return state;
    },
    isLyricsPaused() {
      return lyricsPaused;
    },
    /** Window hidden; process + Halo ownership stay active. */
    hideWindow() {
      if (state === 'releasing' || state === 'exited') return state;
      state = 'hidden';
      return state;
    },
    showWindow() {
      if (state === 'releasing' || state === 'exited') return state;
      state = 'running';
      return state;
    },
    setLyricsPaused(paused) {
      lyricsPaused = Boolean(paused);
      return lyricsPaused;
    },
    beginRelease() {
      state = 'releasing';
      return state;
    },
    markExited() {
      state = 'exited';
      return state;
    }
  };
}

module.exports = {
  createAppLifecycle
};
