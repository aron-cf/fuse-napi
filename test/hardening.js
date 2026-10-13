const childProcess = require('child_process')
const path = require('path')
const tape = require('tape')
const loadBinding = require('node-gyp-build')

const Fuse = require('../')
const binding = loadBinding(path.join(__dirname, '..'))

tape('constructor and mount option inputs are validated', function (t) {
  t.throws(() => new Fuse(''), /Mountpoint/, 'empty mountpoint is rejected')
  t.throws(() => new Fuse('/tmp/a\0b'), /NUL-free/, 'NUL mountpoint is rejected')
  t.throws(() => new Fuse('/tmp/fuse-napi-invalid-ops', []), /Operations/, 'operation arrays are rejected')
  t.throws(
    () => new Fuse('/tmp/fuse-napi-invalid-handler', { read: true }),
    /Operation "read"/,
    'non-function operations are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-invalid-enhanced-handler', { readdirPaged: true }),
    /readdirPaged.*function/,
    'non-function enhanced operations are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-conflicting-operations', {
      readdir () {},
      readdirPaged () {}
    }),
    /mutually exclusive/,
    'legacy and enhanced operation variants cannot conflict'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-unsupported-handler', { error () {} }),
    /not a supported FUSE operation/,
    'nonexistent legacy operation is rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-invalid-timeout', {}, { timeout: -1 }),
    /non-negative safe integer/,
    'negative timeouts are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-unknown-operation', { getatrr () {} }),
    /Unknown FUSE operation/,
    'misspelled operations are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-unknown-option', {}, { allowOthers: true }),
    /Unknown FUSE option/,
    'misspelled options are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-unknown-timeout', {}, { timeout: { rea: 10 } }),
    /Unknown timeout operation/,
    'misspelled timeout operations are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-worker-limit', {}, { maxConcurrency: 0 }),
    /between 1 and 64/,
    'zero native workers are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-worker-limit', {}, { maxConcurrency: 65 }),
    /between 1 and 64/,
    'excessive native workers are rejected'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-read-conflict', { read () {}, readBuffer () {} }),
    /mutually exclusive/,
    'read and readBuffer cannot compete for the same FUSE callback'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-write-conflict', { write () {}, writeBuffer () {} }),
    /mutually exclusive/,
    'write and writeBuffer cannot compete for the same FUSE callback'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-null-getattr', { getattr () {} }, { nullPathOk: true }),
    /nullPathOk.*fgetattr/,
    'nullPathOk requires the handle-aware getattr contract'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-null-chown', { chown () {} }, { nullPathOk: true }),
    /nullPathOk.*chownWithHandle/,
    'nullPathOk requires the handle-aware metadata contract'
  )
  t.throws(
    () => new Fuse('/tmp/fuse-napi-nopath-truncate', { truncate () {} }, { noPath: true }),
    /noPath.*ftruncate/,
    'noPath enforces the same handle-aware contract'
  )

  for (const value of ['name,allow_other', 'name\\allow_other', 'name\nallow_other', 'name\0allow_other']) {
    t.throws(
      () => new Fuse('/tmp/fuse-napi-invalid-option', {}, { fsname: value }),
      /cannot contain/,
      `unsafe mount option ${JSON.stringify(value)} is rejected`
    )
  }
  t.throws(
    () => new Fuse('/tmp/fuse-napi-invalid-boolean', {}, { force: 'yes' }),
    /force must be a boolean/,
    'boolean options are type checked'
  )
  for (const value of [-1, 0x100000000, 1.5, NaN, Infinity, '262144']) {
    t.throws(
      () => new Fuse('/tmp/fuse-napi-invalid-max-read', {}, { maxRead: value }),
      /maxRead must be (?:a safe integer|between 0 and 4294967295)/,
      `invalid maxRead ${String(value)} is rejected before mounting`
    )
  }

  const fuse = new Fuse('/tmp/fuse-napi-timeouts', {}, {
    timeout: { default: false, read: 10, init: 0 }
  })
  t.equal(fuse.timeout.default, false, 'disabled default timeout is preserved')
  t.equal(fuse.timeout.read, 10, 'per-operation timeout is preserved')
  t.equal(fuse.timeout.init, 0, 'zero mount timeout is preserved')
  t.ok(Object.isFrozen(fuse.timeout), 'normalized timeout configuration is immutable')
  t.equal(fuse.maxConcurrency, 4, 'native concurrency has a conservative default')
  t.end()
})

tape('unmount passes the mountpoint as a literal process argument', function (t) {
  const originalExecFile = childProcess.execFile
  const indexPath = require.resolve('../')
  const dangerousPath = '/tmp/fuse;touch /tmp/should-not-exist'
  const unsafeEnvironment = {
    LD_PRELOAD: '/tmp/untrusted-linux-loader.so',
    LD_LIBRARY_PATH: '/tmp/untrusted-linux-libraries',
    DYLD_INSERT_LIBRARIES: '/tmp/untrusted-macos-loader.dylib',
    DYLD_LIBRARY_PATH: '/tmp/untrusted-macos-libraries'
  }
  const originalEnvironment = {}

  for (const [name, value] of Object.entries(unsafeEnvironment)) {
    originalEnvironment[name] = process.env[name]
    process.env[name] = value
  }
  originalEnvironment.FUSE_NAPI_SAFE_HELPER_ENV = process.env.FUSE_NAPI_SAFE_HELPER_ENV
  process.env.FUSE_NAPI_SAFE_HELPER_ENV = 'preserved'

  childProcess.execFile = function (command, args, options, cb) {
    t.ok(command === 'diskutil' || command === 'fusermount3', 'known unmount executable is selected')
    t.equal(args[args.length - 1], dangerousPath, 'mountpoint remains one literal argument')
    if (command === 'fusermount3') {
      t.equal(args[args.length - 2], '--', 'Linux option parsing ends before the mountpoint')
    }
    t.equal(options.shell, false, 'no shell is involved')
    t.equal(options.timeout, 15000, 'standalone unmount has a finite deadline')
    t.equal(options.killSignal, 'SIGKILL', 'a timed-out helper cannot ignore termination')
    t.equal(options.env.FUSE_NAPI_SAFE_HELPER_ENV, 'preserved', 'ordinary environment variables are retained')
    for (const name of Object.keys(unsafeEnvironment)) {
      t.notOk(name in options.env, `${name} cannot inject code into the system helper`)
    }
    t.equal(process.env.LD_PRELOAD, unsafeEnvironment.LD_PRELOAD, 'the parent process environment is not mutated')
    process.nextTick(cb, null)
  }

  delete require.cache[indexPath]
  const IsolatedFuse = require('../')
  IsolatedFuse.unmount(dangerousPath, function (err) {
    childProcess.execFile = originalExecFile
    restoreEnvironment(originalEnvironment)
    delete require.cache[indexPath]
    t.error(err, 'literal argument unmount succeeds')
    t.end()
  })
})

tape('unmount waits until a lazy detach is observable', function (t) {
  const originalExecFile = childProcess.execFile
  const filesystem = require('fs')
  const originalStat = filesystem.stat
  const indexPath = require.resolve('../')
  const mountpoint = '/tmp/fuse-napi-delayed-unmount'
  let mountpointChecks = 0

  childProcess.execFile = function (command, args, options, cb) {
    process.nextTick(cb, null)
  }
  filesystem.stat = function (name, cb) {
    if (name === mountpoint) {
      mountpointChecks++
      const dev = mountpointChecks < 3 ? 2 : 1
      return process.nextTick(cb, null, { dev })
    }
    return process.nextTick(cb, null, { dev: 1 })
  }

  delete require.cache[indexPath]
  const IsolatedFuse = require('../')
  IsolatedFuse.unmount(mountpoint, function (err) {
    childProcess.execFile = originalExecFile
    filesystem.stat = originalStat
    delete require.cache[indexPath]

    t.error(err, 'unmount completes after the mount disappears')
    t.equal(mountpointChecks, 5, 'mountpoint must remain detached across stable observations')
    t.end()
  })
})

tape('unmount accepts a helper race only after stable detach is proven', function (t) {
  const originalExecFile = childProcess.execFile
  const filesystem = require('fs')
  const originalStat = filesystem.stat
  const indexPath = require.resolve('../')
  const mountpoint = '/tmp/fuse-napi-raced-unmount'
  const helperError = new Error('Operation not permitted')
  helperError.code = 'EPERM'
  let mountpointChecks = 0

  childProcess.execFile = function (command, args, options, cb) {
    process.nextTick(cb, helperError)
  }
  filesystem.stat = function (name, cb) {
    if (name === mountpoint) mountpointChecks++
    return process.nextTick(cb, null, { dev: 1 })
  }

  delete require.cache[indexPath]
  const IsolatedFuse = require('../')
  IsolatedFuse.unmount(mountpoint, function (err) {
    childProcess.execFile = originalExecFile
    filesystem.stat = originalStat
    delete require.cache[indexPath]

    t.error(err, 'an unsuccessful helper is idempotent once detach is proven')
    t.equal(mountpointChecks, 3, 'helper failure requires stable detached observations')
    t.end()
  })
})

tape('unmount preserves helper and observation failures when the mount remains', function (t) {
  const originalExecFile = childProcess.execFile
  const filesystem = require('fs')
  const originalStat = filesystem.stat
  const originalNow = Date.now
  const indexPath = require.resolve('../')
  const mountpoint = '/tmp/fuse-napi-attached-unmount'
  const helperError = new Error('Operation not permitted')
  helperError.code = 'EPERM'
  let clockReads = 0

  childProcess.execFile = function (command, args, options, cb) {
    process.nextTick(cb, helperError, 'helper stdout', 'helper stderr')
  }
  filesystem.stat = function (name, cb) {
    const dev = name === mountpoint ? 2 : 1
    process.nextTick(cb, null, { dev })
  }
  Date.now = function () {
    return clockReads++ === 0 ? 0 : 15000
  }

  delete require.cache[indexPath]
  const IsolatedFuse = require('../')
  IsolatedFuse.unmount(mountpoint, function (err) {
    childProcess.execFile = originalExecFile
    filesystem.stat = originalStat
    Date.now = originalNow
    delete require.cache[indexPath]

    t.equal(err && err.code, 'EFUSEUNMOUNT', 'an attached mount has a stable error code')
    t.equal(err && err.cause, helperError, 'the helper failure is retained as the primary cause')
    t.equal(err && err.helperError, helperError, 'the helper diagnostic is directly available')
    t.equal(err && err.helperError && err.helperError.stdout, 'helper stdout', 'helper stdout is retained')
    t.equal(err && err.helperError && err.helperError.stderr, 'helper stderr', 'helper stderr is retained')
    t.equal(
      err && err.observationError && err.observationError.code,
      'EFUSEUNMOUNTWAIT',
      'the failed detach observation is retained'
    )
    t.equal(err && err.mountpoint, mountpoint, 'the failed mountpoint is identified')
    t.match(err && err.message, /failed.*did not detach.*helper stderr/, 'the failure includes bounded helper context')
    t.end()
  })
})

function restoreEnvironment (values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
}

tape('unmount wait is bounded and preserves the disconnect cause', function (t) {
  const originalExecFile = childProcess.execFile
  const filesystem = require('fs')
  const originalStat = filesystem.stat
  const originalNow = Date.now
  const indexPath = require.resolve('../')
  const mountpoint = '/tmp/fuse-napi-stuck-unmount'
  let clockReads = 0

  childProcess.execFile = function (command, args, options, cb) {
    process.nextTick(cb, null)
  }
  filesystem.stat = function (name, cb) {
    const err = new Error('Transport endpoint is not connected')
    err.code = 'ENOTCONN'
    process.nextTick(cb, err)
  }
  Date.now = function () {
    return clockReads++ === 0 ? 0 : 15000
  }

  delete require.cache[indexPath]
  const IsolatedFuse = require('../')
  IsolatedFuse.unmount(mountpoint, function (err) {
    childProcess.execFile = originalExecFile
    filesystem.stat = originalStat
    Date.now = originalNow
    delete require.cache[indexPath]

    t.equal(err && err.code, 'EFUSEUNMOUNTWAIT', 'detach timeout has a stable error code')
    t.equal(err && err.cause && err.cause.code, 'ENOTCONN', 'last disconnect error is retained')
    t.match(err && err.message, /stuck-unmount.*detach/, 'timeout identifies the mountpoint')
    t.end()
  })
})

tape('forced recovery propagates unmount failures without starting a mount', function (t) {
  const filesystem = require('fs')
  const originalStat = filesystem.stat
  const originalUnmount = Fuse.unmount
  const originalCheckEnvironment = Fuse.checkEnvironment
  const unmountError = new Error('fusermount3 failed')
  let environmentChecks = 0

  filesystem.stat = function (name, cb) {
    const err = new Error('Transport endpoint is not connected')
    err.code = 'ENOTCONN'
    process.nextTick(cb, err)
  }
  Fuse.unmount = function (mnt, cb) {
    process.nextTick(cb, unmountError)
  }
  Fuse.checkEnvironment = function (opts, cb) {
    environmentChecks++
    process.nextTick(cb, null)
  }

  const fuse = new Fuse('/tmp/fuse-napi-failed-recovery', {}, { force: true })
  fuse._open(function (err) {
    filesystem.stat = originalStat
    Fuse.unmount = originalUnmount
    Fuse.checkEnvironment = originalCheckEnvironment

    t.equal(err, unmountError, 'the original unmount error reaches the mount callback')
    t.equal(environmentChecks, 0, 'mount startup does not continue after failed recovery')
    t.equal(fuse._thread, null, 'no native mount state is allocated')
    t.end()
  })
})

tape('native mount startup is asynchronous, bounded, and cancellable', function (t) {
  const originalStat = require('fs').stat
  const originalMount = binding.fuse_native_mount
  const originalCancel = binding.fuse_native_cancel_mount
  const originalCheckEnvironment = Fuse.checkEnvironment
  const filesystem = require('fs')
  let mountArguments
  let cancellations = 0

  filesystem.stat = function (name, cb) {
    process.nextTick(cb, null, {
      dev: 1,
      isDirectory () { return true }
    })
  }
  binding.fuse_native_mount = function (...args) {
    mountArguments = args
  }
  binding.fuse_native_cancel_mount = function () {
    cancellations++
  }
  Fuse.checkEnvironment = function (_, cb) {
    process.nextTick(cb, null, { ok: true, platform: process.platform })
  }

  const fuse = new Fuse('/tmp/fuse-napi-async-mount', {
    utimensWithHandle () {}
  }, {
    timeout: { default: false, init: 20 },
    maxConcurrency: 3,
    maxRead: 262144,
    nullPathOk: true,
    noPath: true,
    directIo: true
  })

  fuse._open(function (err) {
    filesystem.stat = originalStat
    binding.fuse_native_mount = originalMount
    binding.fuse_native_cancel_mount = originalCancel
    Fuse.checkEnvironment = originalCheckEnvironment

    t.ok(err, 'startup deadline completes even while native mount work is pending')
    t.equal(cancellations, 1, 'pending native mount receives one cancellation request')
    t.equal(mountArguments[6], 3, 'configured worker bound reaches the native layer')
    t.equal(mountArguments[7], 15, 'FUSE 3 config flags reach the native layer')
    t.equal(typeof mountArguments[8], 'function', 'unexpected loop exit callback is installed')
    t.equal(typeof mountArguments[9], 'function', 'asynchronous mount completion callback is installed')
    t.equal(mountArguments[10], true, 'explicit maxRead presence reaches the native layer')
    t.equal(mountArguments[11], 262144, 'the exact maxRead value reaches the native layer')
    t.equal(fuse._nativeMountPending, true, 'state remains retained until native cancellation finishes')

    const cancelled = new Error('cancelled')
    cancelled.code = 'EFUSEMOUNTCANCELLED'
    mountArguments[9](cancelled)
    t.equal(fuse._nativeMountPending, false, 'late native completion releases pending ownership')
    t.equal(fuse._thread, null, 'late native completion releases the native state buffer')
    t.end()
  })
})

tape('omitted maxRead is represented explicitly at the native boundary', function (t) {
  const filesystem = require('fs')
  const originalStat = filesystem.stat
  const originalMount = binding.fuse_native_mount
  const originalCheckEnvironment = Fuse.checkEnvironment
  let mountArguments

  filesystem.stat = function (name, cb) {
    process.nextTick(cb, null, {
      dev: 1,
      isDirectory () { return true }
    })
  }
  binding.fuse_native_mount = function (...args) {
    mountArguments = args
  }
  Fuse.checkEnvironment = function (_, cb) {
    process.nextTick(cb, null, { ok: true, platform: process.platform })
  }

  const fuse = new Fuse('/tmp/fuse-napi-default-max-read')
  fuse._open(function () {})

  setImmediate(function () {
    filesystem.stat = originalStat
    binding.fuse_native_mount = originalMount
    Fuse.checkEnvironment = originalCheckEnvironment

    t.equal(fuse._fuseOptions(), '', 'no max_read mount option is serialized')
    t.equal(mountArguments[10], false, 'native maxRead presence is false')
    t.equal(mountArguments[11], 0, 'the unused native value has a canonical zero')

    const cancelled = new Error('cancelled')
    cancelled.code = 'EFUSEMOUNTCANCELLED'
    mountArguments[9](cancelled)
    t.end()
  })
})

tape('operation failures, duplicate callbacks, and timeouts signal exactly once', function (t) {
  const originalSignal = binding.fuse_native_signal_access
  const reported = []

  runCase(
    cb => { throw new Error('sync failure') },
    { timeout: false, onError: err => reported.push(err.message) },
    Fuse.EIO
  )
    .then(() => runCase(
      () => Promise.reject(new Error('async failure')),
      { timeout: false, onError: err => reported.push(err.message) },
      Fuse.EIO
    ))
    .then(() => runCase(
      (name, mode, cb) => {
        cb(0)
        cb(Fuse.EIO)
      },
      { timeout: false, onError: err => reported.push(err.message) },
      0
    ))
    .then(() => runCase(
      () => {},
      { timeout: { default: false, access: 10 }, onError: err => reported.push(err.message) },
      Fuse.ETIMEDOUT
    ))
    .then(() => {
      t.deepEqual(reported, ['sync failure', 'async failure'], 'only implementation failures are reported')
    })
    .catch(err => t.fail(err.stack || err.message))
    .finally(() => {
      binding.fuse_native_signal_access = originalSignal
      t.end()
    })

  function runCase (access, opts, expected) {
    return new Promise((resolve, reject) => {
      let calls = 0
      const timer = setTimeout(() => reject(new Error('operation did not signal')), 250)
      binding.fuse_native_signal_access = function (nativeHandler, result) {
        calls++
        try {
          t.equal(result, expected, `operation signals ${expected}`)
          setTimeout(() => {
            try {
              t.equal(calls, 1, 'operation signals once')
              clearTimeout(timer)
              resolve()
            } catch (err) {
              reject(err)
            }
          }, 20)
        } catch (err) {
          clearTimeout(timer)
          reject(err)
        }
      }

      const fuse = new Fuse('/tmp/fuse-napi-operation-errors', { access }, opts)
      fuse._handlers[binding.op_access]({}, binding.op_access, '/test', 0)
    })
  }
})

tape('timed-out reads preserve native errno and ignore late callbacks', async function (t) {
  const originalSignal = binding.fuse_native_signal_read
  const calls = []
  let complete
  let delivered
  const signalled = new Promise(resolve => { delivered = resolve })
  binding.fuse_native_signal_read = function (nativeHandler, result) {
    calls.push(result)
    delivered()
  }
  try {
    const fuse = new Fuse('/tmp/fuse-napi-read-timeout', {
      read (name, fd, buffer, length, position, cb) {
        complete = cb
      }
    }, { timeout: { default: false, read: 10 } })
    const buffer = Buffer.alloc(4)
    t.timeoutAfter(1000)
    fuse._handlers[binding.op_read]({}, binding.op_read, '/file', 1, buffer, buffer.length, 0, 0)
    await signalled
    t.deepEqual(calls, [Fuse.ETIMEDOUT], 'the native boundary receives the original timeout errno')
    complete(buffer.length)
    complete(Fuse.EIO)
    await new Promise(resolve => setImmediate(resolve))
    t.deepEqual(calls, [Fuse.ETIMEDOUT], 'late success and error callbacks cannot send another native response')
    t.doesNotThrow(() => buffer.write('safe'), 'the JavaScript request buffer survives completion')
  } finally {
    binding.fuse_native_signal_read = originalSignal
  }
})

tape('64-bit statistics, offsets, and file handles remain lossless', function (t) {
  const large = 0x20000000000001n
  const beforeEpoch = -2208988800123
  const fuse = new Fuse('/tmp/fuse-napi-64-bit', {
    getattr (name, cb) {
      cb(0, {
        mode: 0o100644,
        size: large,
        ino: large + 1n,
        atime: beforeEpoch,
        mtime: { seconds: large, nanoseconds: 123456789 },
        ctime: 1
      })
    },
    open (name, flags, cb) {
      cb(0, large + 2n)
    },
    truncate (name, size, cb) {
      t.equal(size, -1, 'signed 64-bit offset is decoded')
      cb(0)
    }
  })

  fuse._op_getattr(function (err, stat) {
    t.equal(err, 0, 'large stat succeeds')
    t.equal(joinUint64(stat, 3), large, 'large file size is exact')
    t.equal(joinUint64(stat, 9), large + 1n, 'large inode is exact')
    t.equal(joinInt64(stat, 17), -2208988801n, 'pre-epoch timestamp seconds are normalized')
    t.equal(stat[19], 877000000, 'negative millisecond timestamp retains its subsecond value')
    t.equal(joinInt64(stat, 20), large, 'large timestamp seconds remain lossless')
    t.equal(stat[22], 123456789, 'nanosecond precision remains lossless')
  }, '/test')

  fuse._op_open(function (err, fd) {
    t.equal(err, 0, 'large file handle succeeds')
    t.equal(fd, large + 2n, 'large file handle remains a bigint')
  }, '/test', 0)

  fuse._op_truncate(function (err) {
    t.equal(err, 0, 'signed offset operation succeeds')
  }, '/test', 0xffffffff, 0xffffffff)
  t.end()
})

tape('I/O, directory, readlink, and xattr outputs are bounded', function (t) {
  const errors = []
  const value = Buffer.from('value')
  const fuse = new Fuse('/tmp/fuse-napi-output-validation', {
    read (name, fd, buf, len, position, cb) {
      cb(len + 1)
    },
    readdir (name, cb) {
      cb(0, ['valid', 'invalid/name'])
    },
    readlink (name, cb) {
      cb(0, 'bad\0link')
    },
    getxattr (name, attribute, position, cb) {
      cb(0, value)
    },
    listxattr (name, cb) {
      cb(0, ['user.one', 'user.é'])
    }
  }, {
    onError (err, operation) {
      errors.push([operation, err.constructor.name])
    }
  })

  const readBuffer = Buffer.alloc(4)
  fuse._op_read(function (err, returnedBuffer) {
    t.equal(err, Fuse.EIO, 'oversized read result becomes EIO')
    t.equal(returnedBuffer, readBuffer, 'failed read retains its owned request buffer')
  }, '/test', 1, readBuffer, readBuffer.length, 0, 0)

  fuse._op_readdir(err => t.equal(err, Fuse.EIO, 'invalid directory entry becomes EIO'), '/')
  fuse._op_readlink(err => t.equal(err, Fuse.EIO, 'invalid readlink result becomes EIO'), '/link')

  fuse._op_getxattr(function (result) {
    t.equal(result, value.length, 'zero-length xattr buffer reports exact size')
  }, '/test', 'user.value', Buffer.alloc(0), 0)

  fuse._op_getxattr(function (result) {
    t.equal(result, Fuse.ERANGE, 'undersized xattr buffer returns ERANGE')
  }, '/test', 'user.value', Buffer.alloc(value.length - 1), 0)

  const exact = Buffer.alloc(value.length)
  fuse._op_getxattr(function (result) {
    t.equal(result, value.length, 'exact xattr buffer returns value length')
    t.equal(exact.toString(), 'value', 'xattr value is copied exactly')
  }, '/test', 'user.value', exact, 0)

  const listSize = Buffer.byteLength('user.one') + 1 + Buffer.byteLength('user.é') + 1
  fuse._op_listxattr(function (result) {
    t.equal(result, listSize, 'xattr list size probe uses UTF-8 bytes')
  }, '/', Buffer.alloc(0))

  fuse._op_listxattr(function (result) {
    t.equal(result, Fuse.ERANGE, 'undersized xattr list returns ERANGE')
  }, '/', Buffer.alloc(listSize - 1))

  t.deepEqual(
    errors,
    [['read', 'RangeError'], ['readdir', 'TypeError'], ['readlink', 'TypeError']],
    'invalid operation outputs are reported'
  )
  t.end()
})

tape('enhanced open, create, readdir, and init contracts are lossless', function (t) {
  const largeOffset = 0x20000000000001n
  const calls = []
  const fuse = new Fuse('/tmp/fuse-napi-enhanced-contracts', {
    initWithConfig (connection, cb) {
      t.ok(Object.isFrozen(connection), 'connection snapshot is immutable')
      t.equal(connection.protoMajor, 7, 'protocol major is exposed')
      t.equal(connection.capable, 0b1111, 'kernel capabilities are exposed')
      t.equal(connection.maxRead, 262144, 'active maximum read size is exposed')
      cb(0, {
        maxWrite: 65536,
        maxReadahead: 32768,
        maxBackground: 8,
        congestionThreshold: 4,
        want: 0b0011,
        asyncRead: false
      })
    },
    open (name, flags, cb) {
      cb(0, { fd: largeOffset, directIO: true, keepCache: true, nonseekable: true })
    },
    createWithFlags (name, mode, flags, cb) {
      calls.push([name, mode, flags])
      cb(0, { fd: 42 })
    },
    readdirPaged (name, fd, offset, cb) {
      calls.push([name, fd, offset])
      cb(0, ['entry'], undefined, [largeOffset + 1n])
    }
  })
  fuse._waitForMount = () => {}

  fuse._op_init(function (err, config) {
    t.equal(err, 0, 'validated init configuration succeeds')
    t.deepEqual([...config], [63, 65536, 32768, 8, 4, 3, 0, 0], 'init settings are encoded exactly')
  }, 7, 29, 1, 131072, 65536, 0b1111, 0, 16, 12, 262144)

  fuse._op_open(function (err, fd, flags, backingId) {
    t.equal(backingId, 0, 'open without passthrough sends no backing id')
    t.equal(err, 0, 'enriched open succeeds')
    t.equal(fd, largeOffset, 'enriched open preserves the file handle')
    t.equal(flags, 7, 'all supported file-info result flags are encoded')
  }, '/file', 0)

  fuse._op_create(function (err, fd, flags) {
    t.equal(err, 0, 'createWithFlags succeeds')
    t.equal(fd, 42, 'createWithFlags returns its file handle')
    t.equal(flags, 0, 'unset file-info result flags remain disabled')
  }, '/new', 0o644, 0x241)

  const offsetBits = BigInt.asUintN(64, largeOffset)
  fuse._op_readdir(function (err, names, stats, offsets) {
    t.equal(err, 0, 'paged readdir succeeds')
    t.deepEqual(names, ['entry'], 'paged readdir names are retained')
    t.deepEqual(stats, [], 'optional stats remain empty')
    t.equal(joinInt64(offsets, 0), largeOffset + 1n, 'next offset remains a signed 64-bit value')
  }, '/', 99n, Number(offsetBits & 0xffffffffn), Number(offsetBits >> 32n))

  t.deepEqual(calls, [
    ['/new', 0o644, 0x241],
    ['/', 99n, largeOffset]
  ], 'create flags, directory handle, and incoming offset are forwarded')
  t.end()
})

tape('enhanced contracts reject unsafe values before the native boundary', function (t) {
  const reported = []
  const fuse = new Fuse('/tmp/fuse-napi-enhanced-validation', {
    initWithConfig (connection, cb) {
      cb(0, { want: 0x80 })
    },
    open (name, flags, cb) {
      cb(0, { fd: 1, keepCache: 'yes' })
    },
    readdirPaged (name, fd, offset, cb) {
      cb(0, ['entry'], [], [0])
    }
  }, {
    onError (err, operation) {
      reported.push([operation, err.constructor.name])
    }
  })
  fuse._waitForMount = () => {}

  fuse._op_init(err => t.equal(err, Fuse.EIO, 'unsupported init capabilities become EIO'),
    7, 29, 1, 65536, 65536, 1, 0, 12, 9)
  fuse._op_open(err => t.equal(err, Fuse.EIO, 'invalid file-info flags become EIO'), '/file', 0)
  fuse._op_readdir(err => t.equal(err, Fuse.EIO, 'zero paged offset becomes EIO'), '/', 0, 0, 0)

  t.deepEqual(reported, [
    ['init', 'RangeError'],
    ['open', 'TypeError'],
    ['readdir', 'RangeError']
  ], 'enhanced validation failures are reported with their operation')
  t.end()
})

tape('legacy init remains compatible and maxRead is mount-only configuration', function (t) {
  let legacyCalls = 0
  const legacy = new Fuse('/tmp/fuse-napi-legacy-init', {
    init (cb) {
      legacyCalls++
      cb(0)
    }
  })
  legacy._waitForMount = () => {}

  legacy._op_init(function (err, config) {
    t.equal(err, 0, 'legacy init still completes successfully')
    t.deepEqual([...config], [0, 0, 0, 0, 0, 0, 0, 0], 'legacy init preserves the default configuration')
  }, 7, 29, 1, 131072, 65536, 0b1111, 0, 16, 12, 262144)
  t.equal(legacyCalls, 1, 'legacy init is called exactly once')

  const reported = []
  const enhanced = new Fuse('/tmp/fuse-napi-max-read-init-result', {
    initWithConfig (connection, cb) {
      cb(0, { maxRead: connection.maxRead / 2 })
    }
  }, {
    onError (err, operation) {
      reported.push([operation, err.message])
    }
  })
  enhanced._waitForMount = () => {}

  enhanced._op_init(function (err) {
    t.equal(err, Fuse.EIO, 'initWithConfig cannot return an independent maxRead')
  }, 7, 29, 1, 131072, 65536, 0b1111, 0, 16, 12, 262144)
  t.equal(reported.length, 1, 'the invalid init configuration is reported')
  t.equal(reported[0][0], 'init', 'the report identifies the init operation')
  t.match(reported[0][1], /Unknown init configuration property "maxRead"/)
  t.end()
})

tape('teardown cancels pending operations and coalesces callers', function (t) {
  const originalUnmount = Fuse.unmount
  const originalNativeUnmount = binding.fuse_native_unmount
  const fuse = new Fuse('/tmp/fuse-napi-teardown')
  let cancellations = 0
  let helperCalls = 0
  let nativeCalls = 0
  const results = []

  Fuse.unmount = (mnt, cb) => {
    helperCalls++
    process.nextTick(cb, null)
  }
  binding.fuse_native_unmount = (thread, cb) => {
    nativeCalls++
    process.nextTick(cb, null)
  }
  fuse._nativeMounted = true
  fuse._thread = Buffer.alloc(8)
  const pending = {
    cancel () {
      cancellations++
      fuse._pendingSignals.delete(pending)
    }
  }
  fuse._pendingSignals.add(pending)

  fuse._teardown(null, err => done(err))
  fuse._teardown(null, err => done(err))

  function done (err) {
    results.push(err)
    if (results.length !== 2) return
    Fuse.unmount = originalUnmount
    binding.fuse_native_unmount = originalNativeUnmount
    t.deepEqual(results, [null, null], 'all teardown callers complete')
    t.equal(cancellations, 1, 'pending operation is cancelled once')
    t.equal(nativeCalls, 1, 'native cleanup runs once')
    t.equal(
      helperCalls,
      process.platform === 'darwin' ? 1 : 0,
      'only macOS uses its required force-detach helper'
    )
    t.equal(fuse._thread, null, 'native state reference is released')
    t.equal(fuse._nativeMounted, false, 'mounted state is cleared')
    t.end()
  }
})

tape('request context is immutable and isolated across asynchronous handlers', function (t) {
  const originalSignal = binding.fuse_native_signal_access
  const observed = new Map()
  const signalled = []
  let fuse

  binding.fuse_native_signal_access = function (nativeHandler, result) {
    signalled.push([nativeHandler.id, result])
    if (signalled.length !== 2) return
    binding.fuse_native_signal_access = originalSignal

    t.deepEqual(signalled.sort(), [['one', 0], ['two', 0]], 'both requests complete independently')
    t.equal(observed.get('/one').uid, 501, 'first request retains its uid')
    t.equal(observed.get('/two').uid, 502, 'second request retains its uid')
    t.equal(observed.get('/one').fileInfo.fd, 0x20000000000001n, 'large file handle is lossless')
    t.equal(observed.get('/one').fileInfo.lockOwner, 9, 'lock owner is exposed')
    t.equal(observed.get('/one').fileInfo.directIO, true, 'file-info flags are decoded')
    t.ok(Object.isFrozen(observed.get('/one')), 'request context is frozen')
    t.ok(Object.isFrozen(observed.get('/one').fileInfo), 'file info is frozen')
    t.end()
  }

  fuse = new Fuse('/tmp/fuse-napi-context', {
    async access (name, mode, cb) {
      await new Promise(resolve => setImmediate(resolve))
      observed.set(name, fuse.context())
      cb(0)
    }
  })

  const first = new Uint32Array(11)
  first.set([501, 20, 1234, 0o027, 1, 2, 2, 1, 0x00200000, 9, 0])
  const second = new Uint32Array(11)
  second.set([502, 21, 1235, 0o022, 0, 0, 0, 0, 0, 0, 0])
  fuse._handlers[binding.op_access]({ id: 'one' }, binding.op_access, '/one', 4, first)
  fuse._handlers[binding.op_access]({ id: 'two' }, binding.op_access, '/two', 4, second)
  t.equal(fuse.context(), null, 'context is unavailable outside an operation')
})

tape('request context remains protected until the native response is delivered', function (t) {
  const originalSignal = binding.fuse_native_signal_access
  const originalInvalidate = binding.fuse_native_invalidate_entry
  let nativeSignals = 0
  let nativeInvalidations = 0
  let fuse

  binding.fuse_native_signal_access = function (nativeHandler, result) {
    nativeSignals++
    t.equal(result, 0, 'the filesystem response is still delivered')
  }
  binding.fuse_native_invalidate_entry = function () {
    nativeInvalidations++
  }

  fuse = new Fuse('/tmp/fuse-napi-context-invalidation', {
    access (name, mode, cb) {
      cb(0)
      fuse.invalidateEntry('/file', err => {
        binding.fuse_native_signal_access = originalSignal
        binding.fuse_native_invalidate_entry = originalInvalidate
        t.equal(err && err.code, 'EDEADLK', 'post-callback invalidation is still operation-local')
        t.equal(nativeSignals, 1, 'one native operation response is sent')
        t.equal(nativeInvalidations, 0, 'the unsafe native invalidation is never queued')
        t.end()
      })
    }
  })
  fuse._nativeMounted = true
  fuse._thread = Buffer.alloc(8)
  fuse._handlers[binding.op_access]({}, binding.op_access, '/file', 0, new Uint32Array(11))
})

tape('entry invalidation preserves asynchronous errno callbacks at the native boundary', function (t) {
  t.plan(7)
  const originalInvalidate = binding.fuse_native_invalidate_entry
  const fuse = new Fuse('/tmp/fuse-napi-native-invalidation')
  const thread = Buffer.alloc(8)
  let synchronous = true

  fuse._nativeMounted = true
  fuse._thread = thread
  binding.fuse_native_invalidate_entry = function (receivedThread, parent, name, cb) {
    t.equal(receivedThread, thread, 'the retained mount state reaches native code')
    t.equal(parent, 1, 'a root child uses the FUSE root inode')
    t.equal(name, 'file', 'one validated path component is sent')
    t.equal(typeof cb, 'function', 'native completion uses a callback')
    cb(Fuse.EAGAIN)
  }

  fuse.invalidateEntry('/file', err => {
    binding.fuse_native_invalidate_entry = originalInvalidate
    t.equal(synchronous, false, 'even a synchronous binding completion is deferred')
    t.equal(err && err.code, 'EAGAIN', 'native backpressure retains its errno code')
    t.equal(err && err.errno, Fuse.EAGAIN, 'the signed native errno is retained')
  })
  synchronous = false
})

tape('timespec input preserves nanoseconds and special utimens values', function (t) {
  const calls = []
  const fuse = new Fuse('/tmp/fuse-napi-timespec', {
    utimensWithTimespec (name, atime, mtime, cb) {
      calls.push([name, atime, mtime])
      cb(0)
    }
  })

  fuse._op_utimens(function (err) {
    t.equal(err, 0, 'timespec utimens succeeds')
  }, '/file', 0xffffffff, 0xffffffff, 999999999, 5, 0, Fuse.UTIME_OMIT)

  const [, atime, mtime] = calls[0]
  t.deepEqual(atime, { seconds: -1, nanoseconds: 999999999 }, 'signed time is exact')
  t.deepEqual(mtime, { seconds: 5, nanoseconds: Fuse.UTIME_OMIT }, 'UTIME_OMIT is retained')
  t.ok(Object.isFrozen(atime) && Object.isFrozen(mtime), 'timespec inputs are immutable')

  const legacy = new Fuse('/tmp/fuse-napi-legacy-timespec', {
    utimens (name, receivedAtime, receivedMtime, cb) {
      t.fail('legacy callback must not receive an unrepresentable special value')
    }
  })
  legacy._op_utimens(
    err => t.equal(err, Fuse.EOPNOTSUPP, 'legacy utimens rejects special values predictably'),
    '/file',
    0,
    0,
    Fuse.UTIME_NOW,
    0,
    0,
    0
  )
  t.end()
})

tape('FUSE 3 handle-aware metadata and modern operation contracts are lossless', function (t) {
  const calls = []
  const originalNotifyPoll = binding.fuse_native_notify_poll
  const originalClosePoll = binding.fuse_native_close_poll
  binding.fuse_native_notify_poll = (thread, id) => {
    calls.push(['notifyPoll', thread, id])
    return true
  }
  binding.fuse_native_close_poll = (thread, id) => {
    calls.push(['closePoll', thread, id])
    return true
  }

  const fuse = new Fuse('/tmp/fuse-napi-modern-operations', {
    utimensWithHandle (name, fd, atime, mtime, cb) {
      calls.push(['utimensWithHandle', name, fd, atime, mtime])
      cb(0)
    },
    chownWithHandle (name, fd, uid, gid, cb) {
      calls.push(['chownWithHandle', name, fd, uid, gid])
      cb(0)
    },
    chmodWithHandle (name, fd, mode, cb) {
      calls.push(['chmodWithHandle', name, fd, mode])
      cb(0)
    },
    renameWithFlags (source, destination, flags, cb) {
      calls.push(['renameWithFlags', source, destination, flags])
      cb(0)
    },
    pollWithHandle (name, fd, handle, cb) {
      calls.push(['pollWithHandle', name, fd, handle])
      t.equal(handle.notify(), true, 'a retained poll handle can notify the kernel')
      cb(0, 0x45)
      t.equal(handle.close(), true, 'a retained poll handle can be closed explicitly')
    },
    copyFileRange (
      source,
      sourceFd,
      sourceOffset,
      destination,
      destinationFd,
      destinationOffset,
      length,
      flags,
      cb
    ) {
      calls.push([
        'copyFileRange',
        source,
        sourceFd,
        sourceOffset,
        destination,
        destinationFd,
        destinationOffset,
        length,
        flags
      ])
      cb(7n)
    },
    lseek (name, fd, offset, whence, cb) {
      calls.push(['lseek', name, fd, offset, whence])
      cb(0, 0x20000000000001n)
    }
  })
  fuse._thread = Buffer.alloc(16)

  fuse._op_utimens(
    err => t.equal(err, 0, 'handle-aware utimens succeeds'),
    null,
    1,
    0,
    2,
    3,
    0,
    4,
    0x20000000000001n
  )
  fuse._op_chown(err => t.equal(err, 0, 'handle-aware chown succeeds'),
    null, 501, 20, 0x20000000000001n)
  fuse._op_chmod(err => t.equal(err, 0, 'handle-aware chmod succeeds'),
    null, 0o640, 0x20000000000001n)
  fuse._op_rename(err => t.equal(err, 0, 'flag-aware rename succeeds'),
    '/old', '/new', 2)
  fuse._op_poll((err, events) => {
    t.deepEqual([err, events], [0, 0x45], 'delayed poll reports its initial events')
  }, null, 0x20000000000001n, 42)
  fuse._op_copy_file_range(function (err, copied) {
    t.equal(err, 0, 'copy_file_range succeeds')
    t.equal(joinInt64(copied, 0), 7n, 'copy_file_range preserves its result')
  }, null, 11, 0xffffffff, 0xffffffff, null, 12, 2, 0, 9, 1)
  fuse._op_lseek(function (err, offset) {
    t.equal(err, 0, 'lseek succeeds')
    t.equal(joinInt64(offset, 0), 0x20000000000001n, 'lseek preserves a large offset')
  }, null, 13, 0xffffffff, 0xffffffff, 4)

  const utimens = calls.find(call => call[0] === 'utimensWithHandle')
  t.equal(utimens[1], null, 'utimens receives the null path')
  t.equal(utimens[2], 0x20000000000001n, 'utimens receives the file handle')
  t.deepEqual(utimens[3], { seconds: 1, nanoseconds: 2 }, 'utimens receives exact atime')
  const copy = calls.find(call => call[0] === 'copyFileRange')
  t.equal(copy[3], -1, 'copy_file_range preserves a signed source offset')
  t.equal(copy[6], 2, 'copy_file_range preserves its destination offset')
  const seek = calls.find(call => call[0] === 'lseek')
  t.equal(seek[3], -1, 'lseek preserves a signed input offset')
  t.equal(calls.filter(call => call[0] === 'notifyPoll').length, 1, 'poll notifies once')
  t.equal(calls.filter(call => call[0] === 'closePoll').length, 1, 'poll closes once')

  binding.fuse_native_notify_poll = originalNotifyPoll
  binding.fuse_native_close_poll = originalClosePoll
  t.end()
})

tape('remaining portable FUSE operation contracts are validated and lossless', function (t) {
  const calls = []
  const input = Buffer.from([1, 2, 3, 4])
  const output = Buffer.from([4, 3, 2, 1])
  const fuse = new Fuse('/tmp/fuse-napi-portable-operations', {
    destroy (cb) {
      calls.push(['destroy'])
      cb(0)
    },
    lock (name, fd, command, lock, cb) {
      calls.push(['lock', name, fd, command, lock.start])
      cb(0, { ...lock, pid: 4321 })
    },
    bmap (name, blockSize, index, cb) {
      calls.push(['bmap', blockSize, index])
      cb(0, 0x20000000000001n)
    },
    ioctl (name, fd, command, argument, flags, data, cb) {
      calls.push(['ioctl', argument, flags, data])
      cb(0, output)
    },
    poll (name, fd, cb) {
      calls.push(['poll', fd])
      cb(0, 0x41)
    },
    writeBuffer (name, fd, buffer, length, position, cb) {
      calls.push(['writeBuffer', buffer, length, position])
      cb(length)
    },
    readBuffer (name, fd, length, position, cb) {
      calls.push(['readBuffer', length, position])
      cb(0, Buffer.from('ok'))
    },
    flock (name, fd, operation, cb) {
      calls.push(['flock', operation])
      cb(0)
    },
    fallocate (name, fd, mode, offset, length, cb) {
      calls.push(['fallocate', mode, offset, length])
      cb(0)
    }
  })

  fuse._op_destroy(err => t.equal(err, 0, 'destroy completes'))
  fuse._op_lock(function (err, lock) {
    t.equal(err, 0, 'POSIX lock completes')
    t.equal(lock[6], 4321, 'F_GETLK result is returned')
  }, '/file', 7, 5, 1, 0, 0xffffffff, 0xffffffff, 0, 0, 12)
  fuse._op_bmap(function (err, index) {
    t.equal(err, 0, 'bmap completes')
    t.equal(index, 0x20000000000001n, 'bmap index remains lossless')
  }, '/file', 4096, 2)
  fuse._op_ioctl(function (err, data) {
    t.equal(err, 0, 'ioctl completes')
    t.equal(data, output, 'ioctl returns the validated output buffer')
  }, '/file', 7, 0x1234, 0x20000000000001n, 1, input)
  fuse._op_poll((err, events) => t.deepEqual([err, events], [0, 0x41], 'poll events are returned'),
    '/file', 7)
  fuse._op_write_buf(err => t.equal(err, input.length, 'write_buf byte count is returned'),
    '/file', 7, input, input.length, 0xffffffff, 0xffffffff)
  fuse._op_read_buf(function (err, buffer) {
    t.equal(err, 0, 'read_buf completes')
    t.equal(buffer.toString(), 'ok', 'read_buf returns its owned Buffer')
  }, '/file', 7, 4, 0, 0)
  fuse._op_flock(err => t.equal(err, 0, 'flock completes'), '/file', 7, 2)
  fuse._op_fallocate(err => t.equal(err, 0, 'fallocate completes'),
    '/file', 7, 0, 0, 0, 0, 1)

  t.equal(calls.find(call => call[0] === 'lock')[4], -1, 'lock start is signed')
  t.equal(calls.find(call => call[0] === 'ioctl')[1], 0x20000000000001n, 'ioctl argument is lossless')
  t.equal(calls.find(call => call[0] === 'writeBuffer')[3], -1, 'write_buf offset is signed')
  t.end()
})

tape('teardown preserves platform diagnostics and native ownership failures', function (t) {
  const originalUnmount = Fuse.unmount
  const originalNativeUnmount = binding.fuse_native_unmount
  const reports = []
  const helperError = new Error('standalone helper failed')
  let helperResult = helperError
  let helperCalls = 0
  const fuse = new Fuse('/tmp/fuse-napi-teardown-errors', {}, {
    onError (err, operation) {
      reports.push([err, operation])
    }
  })

  Fuse.unmount = (mnt, cb) => {
    helperCalls++
    process.nextTick(cb, helperResult)
  }
  binding.fuse_native_unmount = (thread, cb) => process.nextTick(cb, null)
  fuse._nativeMounted = true
  fuse._thread = Buffer.alloc(8)
  fuse._teardown(null, function (err) {
    t.error(err, 'native cleanup succeeds independently')
    t.equal(fuse._nativeMounted, false, 'successful native cleanup clears mounted state')
    t.equal(fuse._thread, null, 'successful native cleanup releases state')
    t.equal(helperCalls, process.platform === 'darwin' ? 1 : 0, 'platform helper use is explicit')
    t.deepEqual(
      reports,
      process.platform === 'darwin' ? [[helperError, 'unmount']] : [],
      'platform helper diagnostics are reported only when the helper is required'
    )

    const cleanupError = new Error('attribute cleanup failed')
    cleanupError.cleanupComplete = true
    helperResult = null
    binding.fuse_native_unmount = (thread, cb) => process.nextTick(cb, cleanupError)
    fuse._nativeMounted = true
    fuse._thread = Buffer.alloc(8)
    fuse._teardown(null, function (err) {
      t.equal(err, cleanupError, 'completed native cleanup can still report diagnostics')
      t.equal(fuse._nativeMounted, false, 'completed cleanup clears mounted state despite diagnostics')
      t.equal(fuse._thread, null, 'completed cleanup releases native state')

      const ownershipError = new Error('thread still owned')
      binding.fuse_native_unmount = (thread, cb) => process.nextTick(cb, ownershipError)
      fuse._nativeMounted = true
      fuse._thread = Buffer.alloc(8)
      fuse._teardown(null, function (err) {
        Fuse.unmount = originalUnmount
        binding.fuse_native_unmount = originalNativeUnmount
        t.equal(err, ownershipError, 'incomplete native cleanup is returned')
        t.equal(fuse._nativeMounted, true, 'ownership is retained for a safe retry')
        t.ok(fuse._thread, 'native state remains retained for a safe retry')
        t.end()
      })
    })
  })
})

function joinUint64 (array, index) {
  return (BigInt(array[index + 1]) << 32n) | BigInt(array[index])
}

function joinInt64 (array, index) {
  return BigInt.asIntN(64, joinUint64(array, index))
}

tape('passthrough backing ids are validated before the native boundary', function (t) {
  const reported = []
  const results = {
    '/backed': { fd: 7, backingId: 3 },
    '/unbacked': { fd: 7, backingId: 0, keepCache: true },
    '/negative': { fd: 7, backingId: -1 },
    '/too-large': { fd: 7, backingId: 0x80000000 },
    '/kept': { fd: 7, backingId: 3, keepCache: true },
    '/direct': { fd: 7, backingId: 3, directIO: true }
  }
  const ops = {
    open (name, flags, cb) {
      cb(0, results[name])
    },
    createWithFlags (name, mode, flags, cb) {
      cb(0, results[name])
    },
    opendir (name, flags, cb) {
      cb(0, { fd: 1, backingId: 3 })
    }
  }
  const onError = (err, operation) => reported.push([operation, err.message])
  const fuse = new Fuse('/tmp/fuse-napi-passthrough-results', ops, { onError })

  fuse._op_open(function (err, fd, flags, backingId) {
    t.equal(err, 0, 'a backed open succeeds')
    t.equal(fd, 7, 'the file handle is retained')
    t.equal(flags, 0, 'no file-info flags are set')
    t.equal(backingId, 3, 'the backing id reaches the native boundary')
  }, '/backed', 0)
  fuse._op_create(function (err, fd, flags, backingId) {
    t.equal(err, 0, 'a backed create succeeds')
    t.equal(backingId, 3, 'create forwards the backing id')
  }, '/backed', 0o644, 0x241)
  fuse._op_open(function (err, fd, flags, backingId) {
    t.equal(err, 0, 'a zero backing id is ordinary daemon I/O')
    t.equal(flags, 2, 'keepCache remains available without passthrough')
    t.equal(backingId, 0, 'no backing id is sent')
  }, '/unbacked', 0)
  for (const name of ['/negative', '/too-large', '/kept', '/direct']) {
    fuse._op_open(err => t.equal(err, Fuse.EIO, `${name} is refused with EIO`), name, 0)
  }
  fuse._op_opendir(function (err, ...rest) {
    t.equal(err, Fuse.EIO, 'opendir cannot return a backing id')
    t.equal(rest.length, 0, 'the refused opendir sends no file info')
  }, '/', 0)

  for (const option of ['kernelCache', 'autoCache', 'directIo']) {
    const cached = new Fuse(`/tmp/fuse-napi-passthrough-${option}`, ops, { [option]: true, onError })
    cached._op_open(err => t.equal(err, Fuse.EIO, `${option} mounts refuse a backing id`), '/backed', 0)
  }

  t.deepEqual(reported, [
    ['open', 'file-info.backingId must be a non-negative 32-bit integer'],
    ['open', 'file-info.backingId must be a non-negative 32-bit integer'],
    ['open', 'file-info.backingId cannot be combined with keepCache or directIO'],
    ['open', 'file-info.backingId cannot be combined with keepCache or directIO'],
    ['opendir', 'file-info.backingId is only supported by open and create'],
    ['open', 'file-info.backingId cannot be used with the kernelCache mount option'],
    ['open', 'file-info.backingId cannot be used with the autoCache mount option'],
    ['open', 'file-info.backingId cannot be used with the directIo mount option']
  ], 'each refusal is reported with its reason')
  t.end()
})

tape('maxBackingStackDepth is encoded in its own init slot and bounded', function (t) {
  const reported = []
  for (const depth of [0, 1, 2, 3]) {
    const fuse = new Fuse(`/tmp/fuse-napi-backing-stack-depth-${depth}`, {
      initWithConfig (connection, cb) {
        cb(0, { maxBackingStackDepth: depth })
      }
    }, {
      onError (err, operation) {
        reported.push([operation, err.message])
      }
    })
    fuse._waitForMount = () => {}
    fuse._op_init(function (err, config) {
      if (depth > 1) {
        t.equal(err, Fuse.EIO, `backing depth ${depth} is refused before native negotiation`)
        t.equal(config, undefined, 'no invalid configuration reaches the native boundary')
      } else {
        t.equal(err, 0, `backing depth ${depth} is accepted`)
        t.deepEqual([...config], [64, 0, 0, 0, 0, 0, 0, depth], 'only the stack depth slot and mask are set')
      }
    }, 7, 29, 1, 131072, 65536, 0b1111, 0, 16, 12, 262144)
  }

  t.deepEqual(reported, [
    ['init', 'init configuration.maxBackingStackDepth must be at most 1'],
    ['init', 'init configuration.maxBackingStackDepth must be at most 1']
  ], 'the refusal names the field and the limit')
  t.end()
})

tape('backingOpen and backingClose validate input and preserve native errno', function (t) {
  const originalOpen = binding.fuse_native_backing_open
  const originalClose = binding.fuse_native_backing_close
  const fuse = new Fuse('/tmp/fuse-napi-native-backing')

  t.throws(() => fuse.backingOpen(3), err => err.code === 'ENOTCONN', 'backingOpen requires a mount')
  t.throws(() => fuse.backingClose(1), err => err.code === 'ENOTCONN', 'backingClose requires a mount')

  const thread = Buffer.alloc(8)
  fuse._nativeMounted = true
  fuse._thread = thread
  for (const fd of [-1, 1.5, '3', 0x80000000]) {
    t.throws(() => fuse.backingOpen(fd), TypeError, `backingOpen rejects ${String(fd)}`)
  }
  for (const id of [0, -1, 1.5, 0x80000000]) {
    t.throws(() => fuse.backingClose(id), TypeError, `backingClose rejects ${String(id)}`)
  }

  const calls = []
  let openResult = 9
  let closeResult = 0
  binding.fuse_native_backing_open = (receivedThread, fd) => {
    calls.push(['open', receivedThread === thread, fd])
    return openResult
  }
  binding.fuse_native_backing_close = (receivedThread, id) => {
    calls.push(['close', receivedThread === thread, id])
    return closeResult
  }
  try {
    t.equal(fuse.backingOpen(5), 9, 'the native backing id is returned')
    t.equal(fuse.backingClose(9), undefined, 'a successful close returns nothing')

    openResult = Fuse.EPERM
    t.throws(() => fuse.backingOpen(5), err => err.code === 'EPERM' && err.errno === Fuse.EPERM,
      'a refused registration keeps its errno')
    closeResult = Fuse.ENOENT
    t.throws(() => fuse.backingClose(9), err => err.code === 'ENOENT' && err.errno === Fuse.ENOENT,
      'an unknown backing id keeps its errno')
  } finally {
    binding.fuse_native_backing_open = originalOpen
    binding.fuse_native_backing_close = originalClose
  }

  t.deepEqual(calls, [
    ['open', true, 5],
    ['close', true, 9],
    ['open', true, 5],
    ['close', true, 9]
  ], 'the mount state and arguments reach native code')
  t.end()
})
