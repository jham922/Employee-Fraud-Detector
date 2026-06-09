/**
 * IndexedDB wrapper for storing historical analysis runs.
 * Each run stores the parsed (pre-trend) employee array plus summary stats.
 */

const DB_NAME    = 'fraud-detector-db';
const DB_VERSION = 1;
const STORE      = 'runs';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('runDate', 'runDate', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * @param {{ fileName: string, employeeCount: number, flaggedCount: number,
 *           highRiskCount: number, employees: object[] }} run
 */
export async function saveRun(run) {
  const db = await openDB();
  return tx(db, 'readwrite', store => store.add({ ...run, runDate: Date.now() }));
}

/** @returns {Promise<object[]>} newest first */
export async function getAllRuns() {
  const db = await openDB();
  const all = await tx(db, 'readonly', store => store.getAll());
  return [...all].reverse();
}

/** @param {number} id */
export async function deleteRun(id) {
  const db = await openDB();
  return tx(db, 'readwrite', store => store.delete(id));
}
