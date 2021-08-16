import { Backchannel, EVENTS } from './backchannel';
import { generateKey } from './crypto';
import { randomBytes } from 'crypto';

let doc,
  petbob_id,
  android_id,
  petalice_id = null;
let alice: Backchannel, bob: Backchannel, android: Backchannel;
let server,
  port = 3001;
let relay = `ws://localhost:${port}`;

function createDevice(name?: string): Backchannel {
  let dbname = name || randomBytes(16).toString('hex');
  return new Backchannel(dbname, { relay }, null);
}

test('generate a key', (end) => {
  // start a backchannel on bob and alice's devices
  alice = createDevice();
  bob = createDevice();

  alice.once(EVENTS.OPEN, () => {
    bob.once(EVENTS.OPEN, () => {

      alice.getCode().then(code => {
        let pending = 2
        let done = (key) => {
          console.log(key)
          pending--
          if (pending === 0) end()
        }
        alice.accept(code).then(done)
        bob.accept(code).then(done)
      })
    })
  })
})