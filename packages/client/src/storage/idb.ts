/** Minimal IndexedDB wrapper: user maps, saved games, and online games hosted here (to resume them). */
// Browser storage keeps the game's working name ("krieg"), so saves and settings carry over.
const DB_NAME = 'krieg';
const STORES = ['maps', 'saves', 'hosted'] as const;
type Store = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }));
}

export const idb = {
  put: <T extends { id: string }>(store: Store, value: T) => run<IDBValidKey>(store, 'readwrite', (s) => s.put(value)),
  get: <T>(store: Store, id: string) => run<T | undefined>(store, 'readonly', (s) => s.get(id)),
  all: <T>(store: Store) => run<T[]>(store, 'readonly', (s) => s.getAll()),
  delete: (store: Store, id: string) => run<undefined>(store, 'readwrite', (s) => s.delete(id)),
};
