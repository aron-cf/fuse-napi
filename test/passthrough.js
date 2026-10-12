const fs = require('fs')
const os = require('os')
const path = require('path')
const tape = require('tape')

const Fuse = require('../')
const createMountpoint = require('./fixtures/mnt')
const stat = require('./fixtures/stat')
const { unmount } = require('./helpers')

const mnt = createMountpoint()
const backingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuse-napi-backing-'))
const backingFile = path.join(backingDir, 'data')

// One file served from a backing file on the host. Every open shares one
// backing id, released after the last handle closes, and the read and
// write handlers count calls so a passthrough handle shows up as zero.
function passthroughFs () {
  const state = { capable: false, unavailable: null, id: 0, refs: 0, reads: 0, writes: 0 }
  let fuse = null

  const ops = {
    initWithConfig (connection, cb) {
      state.capable = (connection.capable & Fuse.CAP_PASSTHROUGH) !== 0
      if (!state.capable) return cb(0)
      // The backing directory may itself be on overlayfs.
      cb(0, { want: connection.want | Fuse.CAP_PASSTHROUGH, maxBackingStackDepth: 1 })
    },
    getattr (file, cb) {
      if (file === '/') return process.nextTick(cb, 0, stat({ mode: 'dir', size: 4096 }))
      if (file === '/file') {
        return process.nextTick(cb, 0, stat({ mode: 'file', size: fs.statSync(backingFile).size }))
      }
      return process.nextTick(cb, Fuse.ENOENT)
    },
    open (file, flags, cb) {
      if (file !== '/file') return process.nextTick(cb, Fuse.ENOENT)
      const fd = fs.openSync(backingFile, flags)
      if (state.id === 0 && state.unavailable === null) {
        try {
          state.id = fuse.backingOpen(fd)
        } catch (err) {
          state.unavailable = err.code
        }
      }
      if (state.id > 0) state.refs++
      process.nextTick(cb, 0, state.id > 0 ? { fd, backingId: state.id } : fd)
    },
    read (file, fd, buf, len, pos, cb) {
      state.reads++
      process.nextTick(cb, fs.readSync(fd, buf, 0, len, pos))
    },
    write (file, fd, buf, len, pos, cb) {
      state.writes++
      process.nextTick(cb, fs.writeSync(fd, buf, 0, len, pos))
    },
    release (file, fd, cb) {
      fs.closeSync(fd)
      if (state.refs > 0 && --state.refs === 0) {
        fuse.backingClose(state.id)
        state.id = 0
      }
      process.nextTick(cb, 0)
    }
  }

  fuse = new Fuse(mnt, ops, { force: true })
  return { fuse, state }
}

function mounted (fuse, body) {
  return new Promise((resolve, reject) => {
    fuse.mount(err => {
      if (err) return reject(err)
      body().then(
        () => unmount(fuse, resolve),
        bodyErr => unmount(fuse, () => reject(bodyErr))
      )
    })
  })
}

tape('passthrough handles are served by the kernel', async function (t) {
  if (process.platform !== 'linux') {
    t.skip('FUSE passthrough is Linux-only')
    return
  }
  fs.writeFileSync(backingFile, 'hello passthrough')
  const { fuse, state } = passthroughFs()
  const file = path.join(mnt, 'file')

  await mounted(fuse, async () => {
    const first = await fs.promises.readFile(file, 'utf8')
    if (!state.capable || state.unavailable !== null) {
      t.skip(`passthrough unavailable: ${state.capable ? state.unavailable : 'kernel did not offer it'}`)
      return
    }
    t.equal(first, 'hello passthrough', 'reads return the backing file contents')

    // Two concurrent handles with different access modes share one id.
    const reader = await fs.promises.open(file, 'r')
    const writer = await fs.promises.open(file, 'r+')
    await writer.write('HELLO', 0)
    const { bytesRead, buffer } = await reader.read(Buffer.alloc(17), 0, 17, 0)
    t.equal(buffer.toString('utf8', 0, bytesRead), 'HELLO passthrough', 'a read-only handle sees the write')
    const refused = await reader.write('x', 0).then(() => null, err => err.code)
    t.equal(refused, 'EBADF', 'the read-only handle still refuses to write')
    await reader.close()
    await writer.close()

    t.equal(fs.readFileSync(backingFile, 'utf8'), 'HELLO passthrough', 'writes land in the backing file')
    t.equal(state.reads, 0, 'the read handler was never called')
    t.equal(state.writes, 0, 'the write handler was never called')

    // The kernel sends RELEASE asynchronously after the last close().
    const deadline = Date.now() + 5000
    while (state.refs > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    t.equal(state.id, 0, 'the backing id was released after the last handle')
  })
})
