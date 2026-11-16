import { parentPort } from 'node:worker_threads';
import { fib } from './fib.js';

parentPort.on('message', ({ id, n }) => {
  parentPort.postMessage({ id, result: fib(n) });
});
