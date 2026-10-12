const fs = require('fs')
const os = require('os')
const path = require('path')
const tape = require('tape')
const Fuse = require('../')
const passthroughExample = require('./fixtures/passthrough-example')

class ExampleFuse {
  constructor (mountpoint, ops) {
    this.ops = ops
    this.attempted = []
    this.registered = []
    this.closed = []
    this.nextId = 1
    this.openError = null
    this.closeError = null
  }

  backingOpen (fd) {
    this.attempted.push(fd)
    if (this.openError) throw this.openError
    const id = this.nextId++
    this.registered.push(id)
    return id
  }

  backingClose (id) {
    this.closed.push(id)
    if (this.closeError) throw this.closeError
  }
}
Object.assign(ExampleFuse, Fuse)

function createExample ({ capable = true, statError = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fuse-napi-example-'))
  const file = path.join(directory, 'file')
  const alias = path.join(directory, 'alias')
  fs.writeFileSync(file, 'example data')
  fs.linkSync(file, alias)
  fs.writeFileSync(path.join(directory, 'other'), 'independent data')
  const descriptors = new Set()
  const liveDescriptors = new Set()
  const filesystem = {
    ...fs,
    open (name, flags, cb) {
      fs.open(name, flags, (err, fd) => {
        if (!err) {
          descriptors.add(fd)
          liveDescriptors.add(fd)
        }
        cb(err, fd)
      })
    },
    close (fd, cb) {
      fs.close(fd, err => {
        if (!err) liveDescriptors.delete(fd)
        cb(err)
      })
    },
    fstat (fd, options, cb) {
      if (statError) return process.nextTick(cb, statError)
      fs.fstat(fd, options, cb)
    }
  }
  const fuse = passthroughExample({
    Fuse: ExampleFuse,
    filesystem,
    mountpoint: directory,
    otherOperations: {},
    backingPathFor: name => path.join(directory, name.slice(1))
  })
  fuse.ops.initWithConfig({ capable: capable ? Fuse.CAP_PASSTHROUGH : 0, want: 0 }, () => {})
  return {
    fuse,
    descriptors,
    dispose () {
      for (const fd of liveDescriptors) {
        try { fs.closeSync(fd) } catch (err) {
          if (err.code !== 'EBADF') throw err
        }
      }
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

function open (fuse, name = '/file', flags = 'r') {
  return new Promise(resolve => fuse.ops.open(name, flags, (errno, result) => resolve({ errno, result })))
}

function release (fuse, result, name = '/file') {
  const fd = typeof result === 'number' ? result : result.fd
  return new Promise(resolve => fuse.ops.release(name, fd, resolve))
}

function descriptorClosed (fd) {
  try {
    fs.fstatSync(fd)
    return false
  } catch (err) {
    return err.code === 'EBADF'
  }
}

tape('README passthrough shares ids across concurrent handles and hard links', async function (t) {
  const example = createExample()
  const { fuse } = example
  try {
    const opened = await Promise.all([
      open(fuse), open(fuse, '/file', 'r+'), open(fuse, '/alias'), open(fuse)
    ])
    t.deepEqual(opened.map(value => value.errno), [0, 0, 0, 0], 'all concurrent opens succeed')
    t.deepEqual(opened.map(value => value.result.backingId), [1, 1, 1, 1], 'one id serves every handle of the inode')
    t.equal(fuse.attempted.length, 1, 'the backing inode is registered once')
    t.equal(new Set(opened.map(value => value.result.fd)).size, 4, 'each handle owns its descriptor')
    const other = await open(fuse, '/other')
    t.equal(other.result.backingId, 2, 'a different inode gets a separate registration')
    t.equal(fs.readFileSync(other.result.fd, 'utf8'), 'independent data', 'the second inode retains its own backing file')
    await release(fuse, other.result)
    t.deepEqual(fuse.closed, [2], 'closing another inode cannot retire the shared id')
    for (const value of opened.slice(0, 3)) await release(fuse, value.result)
    t.deepEqual(fuse.closed, [2], 'the shared id stays registered until the last release')
    await release(fuse, opened[3].result)
    t.deepEqual(fuse.closed, [2, 1], 'the last release closes the shared backing id exactly once')
    t.ok(opened.every(value => descriptorClosed(value.result.fd)), 'every released descriptor is closed')

    const reopened = await open(fuse)
    t.equal(reopened.result.backingId, 3, 'a later open gets a fresh registration')
    await release(fuse, reopened.result)
    t.deepEqual(fuse.closed, [2, 1, 3], 'the new registration is also released')
  } finally {
    example.dispose()
  }
})

tape('README passthrough falls back only for unavailable passthrough', async function (t) {
  for (const code of ['ENOTSUP', 'ENOTTY', 'EPERM', 'ELOOP']) {
    const example = createExample()
    const { fuse } = example
    fuse.openError = Object.assign(new Error(code), { code })
    try {
      const opened = await open(fuse)
      t.equal(opened.errno, 0, `${code} permits ordinary I/O`)
      t.equal(typeof opened.result, 'number', 'ordinary I/O receives the file descriptor')
      t.equal(fs.readFileSync(opened.result, 'utf8'), 'example data', 'the fallback descriptor remains usable')
      t.equal(await release(fuse, opened.result), 0, 'the fallback handle releases cleanly')
      t.ok(descriptorClosed(opened.result), 'the fallback descriptor is closed')
      t.deepEqual(fuse.closed, [], 'fallback does not release a nonexistent backing id')
    } finally {
      example.dispose()
    }
  }

  const example = createExample({ capable: false })
  try {
    const opened = await open(example.fuse)
    t.equal(opened.errno, 0, 'a kernel without the capability still opens files')
    t.deepEqual(example.fuse.attempted, [], 'no registration is attempted without the capability')
    await release(example.fuse, opened.result)
    t.ok(descriptorClosed(opened.result), 'the unbacked descriptor is closed')
  } finally {
    example.dispose()
  }
})

tape('README passthrough closes descriptors on open failures and cleanup errors', async function (t) {
  const example = createExample()
  const { fuse } = example
  try {
    fuse.openError = Object.assign(new Error('unexpected registration failure'), { code: 'EIO' })
    const failed = await open(fuse)
    t.equal(failed.errno, Fuse.EIO, 'unexpected registration errors are not hidden by fallback')
    t.equal(failed.result, undefined, 'failed opens return no handle')
    t.ok([...example.descriptors].every(descriptorClosed), 'the failed registration closes its descriptor')

    fuse.openError = null
    fuse.closeError = Object.assign(new Error('registration cleanup failure'), { code: 'EIO' })
    const opened = await open(fuse)
    t.equal(await release(fuse, opened.result), Fuse.EIO, 'cleanup failure is reported to the callback')
    t.ok(descriptorClosed(opened.result.fd), 'cleanup failure still closes the descriptor')

    fuse.closeError = null
    const reopened = await open(fuse)
    t.notEqual(reopened.result.backingId, opened.result.backingId, 'failed cleanup cannot leave a stale id in the cache')
    await release(fuse, reopened.result)

    const missing = await open(fuse, '/missing')
    t.equal(missing.errno, Fuse.ENOENT, 'backing-file open errors retain their errno')
  } finally {
    example.dispose()
  }

  const statFailure = createExample({ statError: Object.assign(new Error('fstat failed'), { code: 'EIO' }) })
  try {
    const failed = await open(statFailure.fuse)
    t.equal(failed.errno, Fuse.EIO, 'fstat failure is reported')
    t.ok([...statFailure.descriptors].every(descriptorClosed), 'fstat failure closes the descriptor')
    t.deepEqual(statFailure.fuse.attempted, [], 'a failed stat cannot register a backing id')
  } finally {
    statFailure.dispose()
  }
})
