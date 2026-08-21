const DB_NAME = "bittery-browser-durability-prototype";
const DB_VERSION = 1;
const OPFS_FILE = "bittery-opfs-probe.json";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("control", { keyPath: "key" });
      db.createObjectStore("operations", { keyPath: "id" });
      db.createObjectStore("objects", { keyPath: "id" });
      db.createObjectStore("overlay", { keyPath: "id" });
      db.createObjectStore("padding", { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionFinished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
  });
}

async function reset() {
  const db = await openDatabase();
  const transaction = db.transaction(["control", "operations", "objects", "overlay", "padding"], "readwrite", { durability: "strict" });
  for (const name of ["control", "operations", "objects", "overlay", "padding"]) transaction.objectStore(name).clear();
  transaction.objectStore("control").put({ key: "replica", commitSequence: 70 });
  await transactionFinished(transaction);
  db.close();

  if (navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(OPFS_FILE); } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
  }
}

async function indexedDbCommit(mode) {
  const db = await openDatabase();
  const stores = ["control", "operations", "objects", "overlay", "padding"];
  const transaction = db.transaction(stores, "readwrite", { durability: "strict" });
  const padding = transaction.objectStore("padding");
  const payload = "x".repeat(32 * 1024);

  transaction.objectStore("control").put({ key: "replica", commitSequence: 71 });
  transaction.objectStore("operations").put({ id: "operation-L2", state: "queued", acceptedSequence: 71 });
  transaction.objectStore("objects").put({ id: "item-A-revision-2", envelope: "opaque-prototype-bytes" });
  transaction.objectStore("overlay").put({ id: "item-A", operation: "operation-L2", head: "revision-2" });

  for (let index = 0; index < 320; index += 1) {
    const request = padding.put({ id: `padding-${index}`, payload });
    if (index === 100) {
      request.onsuccess = () => self.postMessage({ checkpoint: "writes-in-flight" });
    }
  }

  await transactionFinished(transaction);
  db.close();
  self.postMessage({ checkpoint: "committed-before-ack" });
  if (mode === "complete") self.postMessage({ checkpoint: "acknowledged" });
}

async function opfsWrite(mode) {
  if (!navigator.storage?.getDirectory) throw new Error("OPFS is unavailable");
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(OPFS_FILE, { create: true });
  const access = await file.createSyncAccessHandle();
  const bytes = new TextEncoder().encode(JSON.stringify({ commitSequence: 71, operation: "operation-L2", overlay: "item-A/revision-2" }));
  access.truncate(0);
  access.write(bytes, { at: 0 });
  self.postMessage({ checkpoint: "opfs-written-before-flush" });
  if (mode === "complete") {
    access.flush();
    access.close();
    self.postMessage({ checkpoint: "opfs-flushed-and-acknowledged" });
  }
}

self.onmessage = async event => {
  try {
    const { action, mode } = event.data;
    if (action === "reset") await reset();
    if (action === "idb-commit") await indexedDbCommit(mode);
    if (action === "opfs-write") await opfsWrite(mode);
    self.postMessage({ done: action });
  } catch (error) {
    self.postMessage({ error: `${error.name}: ${error.message}` });
  }
};
