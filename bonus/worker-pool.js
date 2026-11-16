import { Worker } from 'node:worker_threads';

/** Fixed-size pool. Jobs beyond `size` wait in a FIFO queue (that queueing is the "pool smaller than load" effect). */
export class WorkerPool {
  #idle = [];
  #queue = [];
  #pending = new Map();
  #nextId = 1;

  constructor(file, size) {
    this.size = size;
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL(file, import.meta.url));
      w.on('message', ({ id, result }) => {
        this.#pending.get(id)(result);
        this.#pending.delete(id);
        this.#release(w);
      });
      this.#idle.push(w);
    }
  }

  run(payload) {
    return new Promise((resolve) => {
      this.#queue.push({ payload, resolve });
      this.#dispatch();
    });
  }

  #dispatch() {
    while (this.#idle.length && this.#queue.length) {
      const w = this.#idle.pop();
      const { payload, resolve } = this.#queue.shift();
      const id = this.#nextId++;
      this.#pending.set(id, resolve);
      w.postMessage({ id, ...payload });
    }
  }

  #release(w) { this.#idle.push(w); this.#dispatch(); }

  async close() { await Promise.all([...this.#idle].map((w) => w.terminate())); }
}
