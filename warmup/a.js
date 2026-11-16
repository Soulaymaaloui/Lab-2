// Warm-up A
console.log('A1');
setTimeout(() => console.log('A2'), 0);
setImmediate(() => console.log('A3'));
process.nextTick(() => console.log('A4'));
Promise.resolve().then(() => console.log('A5'));
console.log('A6');
