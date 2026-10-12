'use strict'

const assert = require('assert/strict')

const Fuse = require('..')

let state = 0x6d2b79f5
const known = [
  'allowOther', 'allowRoot', 'autoUnmount', 'defaultPermissions',
  'kernelCache', 'autoCache', 'directIo', 'useIno', 'noforget', 'remember',
  'entryTimeout', 'attrTimeout', 'maxConcurrency', 'modules', 'fsname'
]

for (let iteration = 0; iteration < 20000; iteration++) {
  const options = {}
  const fields = randomInt(1, 8)
  for (let index = 0; index < fields; index++) {
    const name = random() < 0.8
      ? known[randomInt(0, known.length - 1)]
      : `unknown_${randomInt(0, 1000)}`
    options[name] = randomValue()
  }

  try {
    Fuse.validateOptions(options)
  } catch (err) {
    assert.ok(
      err instanceof TypeError || err instanceof RangeError,
      `validation must fail deterministically, received ${err && err.constructor && err.constructor.name}`
    )
    assert.ok(typeof err.message === 'string' && err.message.length > 0)
  }
}

console.log('Validated 20,000 deterministic option-fuzz cases')

function randomValue () {
  switch (randomInt(0, 7)) {
    case 0: return random() < 0.5
    case 1: return randomInt(-10, 100000)
    case 2: return random() * 100
    case 3: return `value_${randomInt(0, 1000)}`
    case 4: return null
    case 5: return undefined
    case 6: return []
    default: return { value: randomInt(0, 10) }
  }
}

function randomInt (minimum, maximum) {
  return Math.floor(random() * (maximum - minimum + 1)) + minimum
}

function random () {
  state += 0x6d2b79f5
  let value = state
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
