// IndexedDB manager for persistent storage of recorded media
const DB_NAME = 'CrispRecDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Save a new recording into IndexedDB
 * @param {Object} recording
 * @returns {Promise<string>} recording ID
 */
export async function saveRecording(recording) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const record = {
      id: recording.id || 'rec_' + Date.now(),
      title: recording.title || `Recording ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      blob: recording.blob, // Blob WebM
      mimeType: recording.mimeType || 'video/webm',
      duration: recording.duration || 0, // seconds
      fileSize: recording.fileSize || (recording.blob ? recording.blob.size : 0),
      width: recording.width || 1920,
      height: recording.height || 1080,
      hasMic: recording.hasMic ?? true,
      hasNoiseCancellation: recording.hasNoiseCancellation ?? true,
      preset: recording.preset || 'balanced',
      createdAt: recording.createdAt || Date.now()
    };

    const req = store.put(record);
    req.onsuccess = () => resolve(record.id);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve a recording by ID
 * @param {string} id
 */
export async function getRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all recordings, sorted by creation date descending
 */
export async function getAllRecordings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('createdAt');
    const req = index.openCursor(null, 'prev');
    const items = [];

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      } else {
        resolve(items);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete a recording by ID
 * @param {string} id
 */
export async function deleteRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Update recording metadata (e.g., renaming title)
 * @param {string} id
 * @param {Object} updates
 */
export async function updateRecording(id, updates) {
  const db = await openDB();
  return new Promise(async (resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      if (!getReq.result) {
        return reject(new Error('Recording not found'));
      }
      const updated = { ...getReq.result, ...updates };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Calculate total storage used by recordings in bytes
 */
export async function getStorageUsage() {
  const all = await getAllRecordings();
  let totalBytes = 0;
  for (const item of all) {
    totalBytes += item.fileSize || 0;
  }
  return {
    count: all.length,
    bytes: totalBytes,
    megabytes: (totalBytes / (1024 * 1024)).toFixed(1)
  };
}

