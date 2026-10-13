const fs = require('fs')
const path = require('path')
const tape = require('tape')

const Fuse = require('../')
const createMountpoint = require('./fixtures/mnt')
const stat = require('./fixtures/stat')
const { unmount } = require('./helpers')
const binding = require('node-gyp-build')(path.join(__dirname, '..'))

tape('timed-out direct read buffers remain valid request-owned memory', function (t) {
  timedOutRead(t, true, ['ETIMEDOUT'])
})

tape('timed-out Linux cached reads retain safe buffers across kernel error normalization', function (t) {
  if (process.platform !== 'linux') {
    t.skip('Linux page-cache error propagation')
    t.end()
    return
  }
  timedOutRead(t, false, ['ETIMEDOUT', 'EIO'])
})

function timedOutRead (t, directIO, expectedCodes) {
  const mnt = createMountpoint()
  let retainedBuffer
  let lateComplete
  const completions = []
  const ops = {
    getattr (name, cb) {
      if (name === '/') return process.nextTick(cb, 0, stat({ mode: 'dir', size: 4096 }))
      if (name === '/file') return process.nextTick(cb, 0, stat({ mode: 'file', size: 4 }))
      return process.nextTick(cb, Fuse.ENOENT)
    },
    open (name, flags, cb) {
      process.nextTick(cb, 0, { fd: 1, directIO })
    },
    read (name, fd, buffer, length, position, cb) {
      retainedBuffer = buffer
      lateComplete = cb
      // Deliberately let the operation timeout.
    },
    release (name, fd, cb) {
      process.nextTick(cb, 0)
    }
  }
  // Capture only this instance's native read replies. Restore the shared
  // binding immediately after its handler closures have been constructed.
  const originalSignal = binding.fuse_native_signal_read
  let fuse
  binding.fuse_native_signal_read = function (nativeHandler, result, ...args) {
    completions.push(result)
    return originalSignal(nativeHandler, result, ...args)
  }
  try {
    fuse = new Fuse(mnt, ops, {
      force: true,
      timeout: { default: false, read: 25 }
    })
  } finally {
    binding.fuse_native_signal_read = originalSignal
  }
  const keepAlive = setTimeout(() => {
    t.fail('mount did not complete')
    t.end()
  }, 5000)

  fuse.mount(function (err) {
    clearTimeout(keepAlive)
    if (err) {
      t.fail(err.stack || err.message)
      fs.rmdir(mnt, () => t.end())
      return
    }

    fs.readFile(path.join(mnt, 'file'), function (err) {
      // Direct I/O preserves the FUSE errno. Cached reads can reduce a failed
      // folio fill to EIO, depending on the kernel version and read path.
      t.ok(expectedCodes.includes(err && err.code), `kernel reports ${expectedCodes.join(' or ')} (received ${err && err.code})`)
      t.ok(completions.length > 0 && completions.every(result => result === Fuse.ETIMEDOUT),
        'every native read reply retains ETIMEDOUT, including cached reads')
      const completedReplies = completions.length
      t.ok(Buffer.isBuffer(retainedBuffer), 'read received a Node.js-owned Buffer')
      if (Buffer.isBuffer(retainedBuffer)) {
        t.doesNotThrow(() => retainedBuffer.write('safe'), 'buffer remains writable after native completion')
        t.equal(retainedBuffer.toString('utf8', 0, 4), 'safe', 'retained buffer storage remains intact')
        t.doesNotThrow(() => {
          lateComplete(retainedBuffer.length)
          lateComplete(Fuse.EIO)
        }, 'late success and error callbacks are ignored after timeout')
      }

      unmount(fuse, function (err) {
        t.error(err, 'filesystem unmounts cleanly')
        if (lateComplete) {
          t.doesNotThrow(() => lateComplete(0), 'a callback after native teardown cannot signal freed request state')
        }
        t.equal(completions.length, completedReplies, 'late callbacks never deliver another native reply')
        fs.rmdir(mnt, () => t.end())
      })
    })
  })
}
