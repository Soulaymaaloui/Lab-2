// Warm-up B
async function f() {
  console.log('B1');
  await g();
  console.log('B2');
}
async function g() { console.log('B3'); }
f();
console.log('B4');
