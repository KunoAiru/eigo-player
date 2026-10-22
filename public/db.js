// IndexedDB store for audio imported onto this device (works offline).
const DB_NAME = 'audio-player';
const STORE = 'tracks';

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('bookId', 'bookId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const getAllTracks = () => run('readonly', (s) => s.getAll());
export const putTracks = (tracks) => run('readwrite', (s) => tracks.forEach((t) => s.put(t)));
export const getTrack = (id) => run('readonly', (s) => s.get(id));

export function deleteBook(bookId) {
  return run('readwrite', (s) => {
    s.index('bookId').openKeyCursor(IDBKeyRange.only(bookId)).onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { s.delete(cur.primaryKey); cur.continue(); }
    };
  });
}
