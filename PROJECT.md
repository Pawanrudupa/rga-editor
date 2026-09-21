# CRDT Offline-First Collaborative Editor — Project Spec

## 1. Project Context

I am building a zero-dependency, offline-first collaborative text editor from scratch, as a portfolio project for software engineering internship applications (target: Google SWE Intern). The core requirement is that I implement the CRDT (Conflict-free Replicated Data Type) merge algorithm myself — no Yjs, Automerge, ShareDB, or any collaborative-editing library. No npm packages of any kind for the core logic; only native browser APIs (BroadcastChannel, WebRTC, IndexedDB, Canvas). Plain JavaScript (ES6+), no framework (no React/Vue). The goal is technical depth I can defend in an interview, not fastest time-to-demo. Prioritize correctness of the merge algorithm and clear, well-commented code over feature breadth. Work in small, independently testable increments and write convergence tests before wiring up any UI.

---

## 2. Architecture

```
/crdt-editor
├── src/
│   ├── crdt.js          # Pure CRDT data structure — no DOM, no networking
│   ├── clock.js         # Lamport clock / site-ID generation
│   ├── sync-local.js    # BroadcastChannel transport (same-device, multi-tab)
│   ├── sync-remote.js   # WebRTC data-channel transport (cross-device)
│   ├── persistence.js   # IndexedDB — offline op queue + snapshot storage
│   ├── editor.js         # DOM binding: textarea/contenteditable ↔ CRDT ops
│   ├── presence.js       # Remote cursor/selection rendering (stretch goal)
│   └── qr.js              # Canvas-drawn QR encode/decode for WebRTC handshake
├── tests/
│   ├── convergence.test.js   # Out-of-order op application → same final state
│   ├── concurrent-insert.test.js
│   ├── concurrent-delete.test.js
│   └── tombstone.test.js
├── index.html
└── README.md              # Algorithm explanation + diagram (interview cheat sheet)
```

**Design principle:** `crdt.js` must never import or know about the DOM, networking, or storage. It takes operations in, returns the current document state out. This separation is what makes it testable and is also exactly the kind of modularity an interviewer will probe.

---

## 3. Methodology — the algorithm to implement

**Chosen CRDT:** RGA (Replicated Growable Array) — the most approachable text-CRDT to hand-roll, and the one that maps cleanly to "linked list of uniquely-identified characters."

**Core idea:**
- Every character inserted gets a globally unique ID: `{siteId, counter}` (a Lamport timestamp — `siteId` breaks ties, `counter` increases monotonically per site).
- Instead of storing text as a plain string, store it as a linked list of `{id, char, deletedFlag}` nodes, each pointing to the ID of the node it was inserted after.
- **Insert(afterId, char):** create a new node with a fresh ID, splice it into the list immediately after `afterId`, but resolve concurrent inserts at the same position deterministically by comparing IDs (higher site ID wins ties) — this is what guarantees convergence.
- **Delete(id):** don't remove the node — mark it as a tombstone (`deletedFlag = true`). This is essential: removing nodes outright breaks convergence when a delete and a concurrent insert-after-that-node race each other.
- **Convergence guarantee:** applying the same set of operations in *any* order, on *any* replica, produces the same final list (same visible string, ignoring tombstones). This is the property your tests must prove.

**Explicitly plan for (and document) these edge cases:**
1. Two sites insert at the same position concurrently → must converge to a consistent, deterministic order.
2. Site A deletes a character while Site B concurrently inserts *after* that same character → the insert must not be lost.
3. Delete of an already-deleted character (duplicate delete op arriving twice) → idempotent, no error.
4. Tombstone accumulation — note in the README that pure RGA never garbage-collects tombstones, and either implement a basic GC (safe once all sites are known to have seen an op) or explicitly document it as a known limitation.

---

## 4. Phased Plan

| Phase | Goal | Demo artifact |
|---|---|---|
| 1 | RGA data structure, pure JS, no UI | Passing convergence tests |
| 2 | Wire to `<textarea>` + BroadcastChannel | Two tabs typing, live merge |
| 3 | WebRTC cross-device + IndexedDB offline queue | Two devices, offline/reconnect demo |
| 4 | Presence cursors, tombstone GC, README/diagram | Polished repo, interview-ready |

Work through these phases in order. Do not start a phase until the previous one's demo artifact is working and I've reviewed it. Always show a plan before writing code.
