const fs = require('fs')
const os = require('os')
const path = require('path')
const tape = require('tape')

const Fuse = require('../')
const createMountpoint = require('./fixtures/mnt')
const stat = require('./fixtures/stat')
const { unmount } = require('./helpers')
const passthroughExample = require('./fixtures/passthrough-example')

// One file served from a backing file on the host. Every open shares one
// backing id, released after the last handle closes, and the read and
// write handlers count calls so a passthrough handle shows up as zero.
function passthroughFs (mnt, backingFile) {
  const state = { capable: false, unavailable: null, registered: [], closed: [], active: new Set(), reads: 0, writes: 0 }
  class ObservedFuse extends Fuse {
    constructor (mountpoint, ops) {
      const init = ops.initWithConfig
      super(mountpoint, {
        ...ops,
        initWithConfig (connection, cb) {
          state.capable = (connection.capable & Fuse.CAP_PASSTHROUGH) !== 0
          init(connection, cb)
        }
      })
    }

    backingOpen (fd) {
      try {
        const id = super.backingOpen(fd)
        state.registered.push(id)
        state.active.add(id)
        return id
      } catch (err) {
        state.unavailable = err.code
        throw err
      }
    }

    backingClose (id) {
      super.backingClose(id)
      state.closed.push(id)
      state.active.delete(id)
    }
  }

  const otherOperations = {
    getattr (file, cb) {
      if (file === '/') return process.nextTick(cb, 0, stat({ mode: 'dir', size: 4096 }))
      if (file === '/file' || file === '/alias' || file === '/other') {
        const backing = file === '/other' ? path.join(path.dirname(backingFile), 'other') : backingFile
        return process.nextTick(cb, 0, stat({ mode: 'file', size: fs.statSync(backing).size }))
      }
      return process.nextTick(cb, Fuse.ENOENT)
    },
    read (file, fd, buf, len, pos, cb) {
      state.reads++
      process.nextTick(cb, fs.readSync(fd, buf, 0, len, pos))
    },
    write (file, fd, buf, len, pos, cb) {
      state.writes++
      process.nextTick(cb, fs.writeSync(fd, buf, 0, len, pos))
    }
  }

  const fuse = passthroughExample({
    Fuse: ObservedFuse,
    mountpoint: mnt,
    otherOperations,
    backingPathFor: file => {
      if (file === '/file') return backingFile
      if (file === '/alias') return path.join(path.dirname(backingFile), 'alias')
      if (file === '/other') return path.join(path.dirname(backingFile), 'other')
      throw Object.assign(new Error('Unknown file'), { code: 'ENOENT' })
    }
  })
  return { fuse, state }
}

async function mounted (fuse, body) {
  await new Promise((resolve, reject) => fuse.mount(err => err ? reject(err) : resolve()))
  try {
    await body()
  } finally {
    await new Promise((resolve, reject) => unmount(fuse, err => err ? reject(err) : resolve()))
  }
}

async function waitForRelease (state) {
  // The kernel sends RELEASE asynchronously after close() completes.
  const deadline = Date.now() + 5000
  while (state.active.size > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (state.active.size > 0) throw new Error('Passthrough backing ids were not released')
}

tape('passthrough handles are served by the kernel', async function (t) {
  if (process.platform !== 'linux') {
    t.skip('FUSE passthrough is Linux-only')
    return
  }
  const mnt = createMountpoint()
  const backingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuse-napi-backing-'))
  const backingFile = path.join(backingDir, 'data')
  fs.writeFileSync(backingFile, 'hello passthrough')
  fs.linkSync(backingFile, path.join(backingDir, 'alias'))
  fs.writeFileSync(path.join(backingDir, 'other'), 'independent file')
  const { fuse, state } = passthroughFs(mnt, backingFile)
  const file = path.join(mnt, 'file')

  try {
    await mounted(fuse, async () => {
      const first = await fs.promises.readFile(file, 'utf8')
      if (!state.capable || state.unavailable !== null) {
        t.skip(`passthrough unavailable: ${state.capable ? state.unavailable : 'kernel did not offer it'}`)
        return
      }
      t.equal(first, 'hello passthrough', 'reads return the backing file contents')
      await waitForRelease(state)
      const registrationsBefore = state.registered.length

      // Concurrent handles and a hard-link alias must share one registration.
      const opened = await Promise.allSettled([
        fs.promises.open(file, 'r'),
        fs.promises.open(file, 'r+'),
        fs.promises.open(path.join(mnt, 'alias'), 'r')
      ])
      const handles = opened.filter(result => result.status === 'fulfilled').map(result => result.value)
      try {
        const failure = opened.find(result => result.status === 'rejected')
        if (failure) throw failure.reason
        const [reader, writer, alias] = handles
        t.equal(state.registered.length, registrationsBefore + 1, 'concurrent opens and hard links register one backing id')
        t.equal(await fs.promises.readFile(path.join(mnt, 'other'), 'utf8'), 'independent file', 'a distinct inode keeps its own backing file')
        t.equal(state.registered.length, registrationsBefore + 2, 'a distinct inode gets its own registration')
        await writer.write('HELLO', 0)
        const { bytesRead, buffer } = await reader.read(Buffer.alloc(17), 0, 17, 0)
        t.equal(buffer.toString('utf8', 0, bytesRead), 'HELLO passthrough', 'a read-only handle sees the write')
        t.equal((await alias.read(Buffer.alloc(5), 0, 5, 0)).buffer.toString(), 'HELLO', 'the hard-link handle sees the write')
        const refused = await reader.write('x', 0).then(() => null, err => err.code)
        t.equal(refused, 'EBADF', 'the read-only handle still refuses to write')
      } finally {
        await Promise.all(handles.map(handle => handle.close()))
      }

      t.equal(fs.readFileSync(backingFile, 'utf8'), 'HELLO passthrough', 'writes land in the backing file')
      t.equal(state.reads, 0, 'the read handler was never called')
      t.equal(state.writes, 0, 'the write handler was never called')

      await waitForRelease(state)
      t.equal(state.closed.length, state.registered.length, 'every backing id was released exactly once')
      const registrationsAfter = state.registered.length
      t.equal(await fs.promises.readFile(file, 'utf8'), 'HELLO passthrough', 'the file can be reopened after its last release')
      await waitForRelease(state)
      t.equal(state.registered.length, registrationsAfter + 1, 'reopening creates a fresh backing id')
      t.equal(state.closed.length, state.registered.length, 'the reopened handle also releases its backing id')
    })
  } finally {
    fs.rmSync(backingDir, { recursive: true, force: true })
    fs.rmdirSync(mnt)
  }
})
