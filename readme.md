BasketballGM 2D Game Visualizer

How to run:

- Save `index.html`, `app.js`, and `styles.css` into the same folder.
- Open `index.html` in a modern browser (Chrome/Edge/Firefox).
- Click "Load league.json" and choose your Basketball GM `league.json` file.
- Select Home and Away teams, then press "Start Game".

Notes:

- The visualizer uses available player ratings from `league.json` if present (it looks for `players` and their `ratings[0].ovr`), otherwise falls back to defaults.
- This is a simplified simulator and animation, designed to be robust to different Basketball GM JSON versions.
