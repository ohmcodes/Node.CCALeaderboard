// Player store: one record per browser id, kept in memory and saved to a JSON file.
// Small and dependency-free on purpose: a jam leaderboard has thousands of rows at most.

const fs = require('node:fs');
const path = require('node:path');

const NAME_MAX = 24;

/** Strips control characters, angle brackets and runs of spaces; returns '' when nothing is left. */
function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

/** Browser ids are UUID-like strings the game makes once and keeps in localStorage. */
function isValidPlayerId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

/** Higher score first, then faster best time (no time last), then whoever got there first. */
function compareEntries(a, b) {
  if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
  const at = a.bestTime == null ? Infinity : a.bestTime;
  const bt = b.bestTime == null ? Infinity : b.bestTime;
  if (at !== bt) return at - bt;
  return a.bestScoreAt - b.bestScoreAt;
}

class Store {
  constructor(file) {
    this.file = file;
    this.players = new Map(); // id -> record
    this.ranked = null;       // sorted cache, rebuilt on change
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const p of data.players || []) {
        if (isValidPlayerId(p.id)) this.players.set(p.id, p);
      }
      console.log(`[store] loaded ${this.players.size} players from ${this.file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[store] could not read', this.file, err.message);
    }
  }

  /** Debounced atomic write (temp file + rename) so a crash never leaves half a file. */
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 500);
  }

  flush() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body = JSON.stringify({ version: 1, players: [...this.players.values()] });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, this.file);
  }

  /** Players with at least one run, best first. */
  getRanked() {
    if (!this.ranked) {
      this.ranked = [...this.players.values()].filter((p) => p.runs > 0).sort(compareEntries);
    }
    return this.ranked;
  }

  invalidate() {
    this.ranked = null;
    this.scheduleSave();
  }

  rankOf(id) {
    const i = this.getRanked().findIndex((p) => p.id === id);
    return i < 0 ? 0 : i + 1;
  }

  /** Public view of a record (never includes the browser id of other players). */
  view(p, rank, viewerId) {
    return {
      rank,
      name: p.name,
      bestScore: p.bestScore,
      bestTime: p.bestTime,
      runs: p.runs,
      cleanRuns: p.cleanRuns || 0,
      lastPlayed: p.lastPlayed,
      isYou: !!viewerId && p.id === viewerId,
    };
  }

  setName(id, name) {
    const now = Date.now();
    let p = this.players.get(id);
    if (!p) {
      p = { id, name, bestScore: 0, bestScoreAt: now, bestTime: null, runs: 0, cleanRuns: 0, created: now, lastPlayed: null };
      this.players.set(id, p);
    }
    p.name = name;
    this.invalidate();
    return p;
  }

  /**
   * Records a finished game. Keeps the best score, and the best (lowest) time of a run that cleaned the
   * whole set. Returns what changed.
   */
  submitRun(id, name, run) {
    const now = Date.now();
    let p = this.players.get(id);
    if (!p) {
      p = { id, name, bestScore: run.score, bestScoreAt: now, bestTime: null, runs: 0, cleanRuns: 0, created: now, lastPlayed: now };
      this.players.set(id, p);
    }
    if (name) p.name = name;

    const firstRun = p.runs === 0;
    let newBestScore = false;
    let newBestTime = false;
    if (firstRun || run.score > p.bestScore) {
      p.bestScore = run.score;
      p.bestScoreAt = now;
      newBestScore = true;
    }
    if (run.setClean) {
      p.cleanRuns = (p.cleanRuns || 0) + 1;
      if (p.bestTime == null || run.timeSeconds < p.bestTime) {
        p.bestTime = run.timeSeconds;
        newBestTime = true;
      }
    }
    p.runs += 1;
    p.lastPlayed = now;
    p.lastRun = { ...run, at: now };
    this.invalidate();
    return { player: p, newBestScore, newBestTime };
  }
}

module.exports = { Store, cleanName, isValidPlayerId, compareEntries, NAME_MAX };
