(() => {
  "use strict";

  const DB_NAME = "bittery-browser-durability-prototype";
  const DB_VERSION = 1;
  const OPFS_FILE = "bittery-opfs-probe.json";

  const initialState = () => ({
    busy: false,
    lastAction: "none",
    classification: "not measured",
    environment: {
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      indexedDb: "indexedDB" in window,
      opfs: Boolean(navigator.storage?.getDirectory),
      persistence: "not queried",
      quota: "not queried"
    },
    replica: {
      store: "not inspected",
      commitSequence: "—",
      operation: "—",
      encryptedObject: "—",
      overlay: "—",
      partialState: "—",
      opfsProbe: "not inspected"
    },
    log: []
  });

  let state = initialState();

  const stateMachine = {
    transition(current, event) {
      const next = structuredClone(current);
      if (event.type === "START") {
        next.busy = true;
        next.lastAction = event.label;
        next.log.unshift(`Started: ${event.label}`);
      }
      if (event.type === "ENVIRONMENT") next.environment = { ...next.environment, ...event.value };
      if (event.type === "INSPECTED") {
        next.replica = event.replica;
        next.classification = classifyReplica(event.replica);
        next.log.unshift(`Recovered: ${next.classification}`);
      }
      if (event.type === "NOTE") next.log.unshift(event.message);
      if (event.type === "FINISH") next.busy = false;
      if (event.type === "ERROR") {
        next.busy = false;
        next.classification = "experiment error";
        next.log.unshift(event.message);
      }
      return next;
    }
  };

  function classifyReplica(replica) {
    if (replica.store === "absent") return "origin state absent — unsynced work can be lost";
    if (replica.partialState === "yes") return "FAIL: partial logical commit exposed";
    if (replica.commitSequence === 70 && replica.operation === "absent" && replica.encryptedObject === "absent" && replica.overlay === "absent") return "whole old commit recovered";
    if (replica.commitSequence === 71 && replica.operation === "queued" && replica.encryptedObject === "present" && replica.overlay === "present") return "whole new commit recovered";
    return "unexpected or incomplete state";
  }

  function dispatch(event) {
    state = stateMachine.transition(state, event);
    render();
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [name, keyPath] of [["control", "key"], ["operations", "id"], ["objects", "id"], ["overlay", "id"], ["padding", "id"]]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function inspectReplica() {
    const databases = indexedDB.databases ? await indexedDB.databases() : null;
    const knownAbsent = databases && !databases.some(database => database.name === DB_NAME);
    let replica;
    if (knownAbsent) {
      replica = { store: "absent", commitSequence: "—", operation: "absent", encryptedObject: "absent", overlay: "absent", partialState: "no", opfsProbe: await inspectOpfs() };
    } else {
      const db = await openDatabase();
      const transaction = db.transaction(["control", "operations", "objects", "overlay"], "readonly");
      const [control, operation, object, overlay] = await Promise.all([
        requestValue(transaction.objectStore("control").get("replica")),
        requestValue(transaction.objectStore("operations").get("operation-L2")),
        requestValue(transaction.objectStore("objects").get("item-A-revision-2")),
        requestValue(transaction.objectStore("overlay").get("item-A"))
      ]);
      db.close();
      const flags = [Boolean(operation), Boolean(object), Boolean(overlay)];
      replica = {
        store: control ? "present" : "empty",
        commitSequence: control?.commitSequence ?? "—",
        operation: operation?.state ?? "absent",
        encryptedObject: object ? "present" : "absent",
        overlay: overlay ? "present" : "absent",
        partialState: flags.some(Boolean) && !flags.every(Boolean) ? "yes" : "no",
        opfsProbe: await inspectOpfs()
      };
    }
    dispatch({ type: "INSPECTED", replica });
  }

  async function inspectOpfs() {
    if (!navigator.storage?.getDirectory) return "unavailable";
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(OPFS_FILE);
      const text = await (await handle.getFile()).text();
      return text ? `${text.length} bytes: ${text}` : "empty file";
    } catch (error) {
      return error.name === "NotFoundError" ? "absent" : `${error.name}: ${error.message}`;
    }
  }

  function workerAction(message, stopAt) {
    return new Promise((resolve, reject) => {
      const worker = new Worker("durability-worker.js");
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Worker timed out"));
      }, 20000);
      worker.onmessage = event => {
        if (event.data.error) {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(event.data.error));
          return;
        }
        if (event.data.checkpoint) dispatch({ type: "NOTE", message: `Worker checkpoint: ${event.data.checkpoint}` });
        if (stopAt && event.data.checkpoint === stopAt) {
          clearTimeout(timer);
          worker.terminate();
          dispatch({ type: "NOTE", message: `Worker forcibly terminated at ${stopAt}` });
          setTimeout(resolve, 250);
        } else if (event.data.done) {
          clearTimeout(timer);
          worker.terminate();
          resolve();
        }
      };
      worker.onerror = event => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.postMessage(message);
    });
  }

  async function refreshEnvironment() {
    const [persisted, estimate] = await Promise.all([
      navigator.storage?.persisted?.() ?? Promise.resolve(false),
      navigator.storage?.estimate?.() ?? Promise.resolve({})
    ]);
    const usage = estimate.usage == null ? "unavailable" : `${(estimate.usage / 1024 / 1024).toFixed(2)} MiB used of ${(estimate.quota / 1024 / 1024).toFixed(0)} MiB`;
    dispatch({ type: "ENVIRONMENT", value: { persistence: persisted ? "granted" : "not granted", quota: usage } });
  }

  function deleteDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Database deletion blocked by an open connection"));
    });
  }

  async function clearOrigin() {
    await deleteDatabase();
    if (navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      try { await root.removeEntry(OPFS_FILE); } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
    }
  }

  async function run(action) {
    const labels = {
      reset: "reset to known commit 70",
      inspect: "reopen and inspect",
      "refresh-environment": "refresh browser policy",
      "idb-kill-mid": "kill during IndexedDB commit",
      "idb-kill-after-commit": "kill after IndexedDB commit before acknowledgement",
      "idb-complete": "complete and acknowledge IndexedDB commit",
      "opfs-kill-before-flush": "kill OPFS write before flush",
      "opfs-complete": "flush and acknowledge OPFS write",
      "clear-origin": "remove the origin stores"
    };
    dispatch({ type: "START", label: labels[action] });
    try {
      if (action === "reset") await workerAction({ action: "reset" });
      if (action === "inspect") await inspectReplica();
      if (action === "refresh-environment") await refreshEnvironment();
      if (action === "idb-kill-mid") await workerAction({ action: "idb-commit", mode: "kill-mid" }, "writes-in-flight");
      if (action === "idb-kill-after-commit") await workerAction({ action: "idb-commit", mode: "kill-after-commit" }, "committed-before-ack");
      if (action === "idb-complete") await workerAction({ action: "idb-commit", mode: "complete" }, "acknowledged");
      if (action === "opfs-kill-before-flush") await workerAction({ action: "opfs-write", mode: "kill-before-flush" }, "opfs-written-before-flush");
      if (action === "opfs-complete") await workerAction({ action: "opfs-write", mode: "complete" }, "opfs-flushed-and-acknowledged");
      if (action === "clear-origin") await clearOrigin();
      if (action !== "inspect" && action !== "refresh-environment") await inspectReplica();
      dispatch({ type: "FINISH" });
    } catch (error) {
      dispatch({ type: "ERROR", message: `${error.name}: ${error.message}` });
    }
  }

  function renderDefinitionList(element, values) {
    element.replaceChildren(...Object.entries(values).map(([name, value]) => {
      const wrapper = document.createElement("div");
      wrapper.className = "state-card";
      const term = document.createElement("dt");
      term.textContent = name.replace(/([A-Z])/g, " $1").replace(/^./, character => character.toUpperCase());
      const description = document.createElement("dd");
      description.textContent = String(value);
      wrapper.append(term, description);
      return wrapper;
    }));
  }

  function render() {
    renderDefinitionList(document.querySelector("#environment-state"), state.environment);
    renderDefinitionList(document.querySelector("#replica-state"), state.replica);
    const verdict = document.querySelector("#verdict");
    verdict.textContent = state.classification;
    verdict.className = `verdict ${state.classification.startsWith("FAIL") ? "bad" : state.classification.includes("whole") ? "good" : state.classification.includes("absent") || state.classification.includes("unexpected") ? "caution" : "neutral"}`;
    const log = document.querySelector("#event-log");
    log.replaceChildren(...state.log.map(message => {
      const item = document.createElement("li");
      item.textContent = message;
      return item;
    }));
    document.querySelectorAll("[data-action]").forEach(button => { button.disabled = state.busy; });
  }

  document.addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) run(action);
    const tab = event.target.closest("[data-tab]")?.dataset.tab;
    if (tab) {
      document.querySelectorAll("[role=tab]").forEach(button => button.setAttribute("aria-selected", String(button.dataset.tab === tab)));
      document.querySelectorAll("[role=tabpanel]").forEach(panel => { panel.hidden = panel.id !== `scenario-${tab}`; });
    }
  });

  render();
  refreshEnvironment().then(inspectReplica).catch(error => dispatch({ type: "ERROR", message: `${error.name}: ${error.message}` }));
})();
