// IndexedDB store for audio and word data imported onto this device (works offline).
const DB_NAME = 'audio-player';
const STORE = 'tracks';
const VOCAB = 'vocab';

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains(VOCAB)) db.createObjectStore(VOCAB, { keyPath: 'title' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const getAllTracks = () => run(STORE, 'readonly', (s) => s.getAll());
export const putTracks = (tracks) => run(STORE, 'readwrite', (s) => tracks.forEach((t) => s.put(t)));
export const getTrack = (id) => run(STORE, 'readonly', (s) => s.get(id));

export function deleteBook(bookId) {
  return run(STORE, 'readwrite', (s) => {
    s.index('bookId').openKeyCursor(IDBKeyRange.only(bookId)).onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { s.delete(cur.primaryKey); cur.continue(); }
    };
  });
}

// Word data, one record per book title: {title, data}.
export const getAllVocab = () => run(VOCAB, 'readonly', (s) => s.getAll());
export const putVocab = (title, data) => run(VOCAB, 'readwrite', (s) => s.put({ title, data }));
export const deleteVocab = (title) => run(VOCAB, 'readwrite', (s) => s.delete(title));
