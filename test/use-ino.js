const fs = require('fs')
const path = require('path')
const tape = require('tape')

const Fuse = require('../')
const createMountpoint = require('./fixtures/mnt')
const stat = require('./fixtures/stat')
const { unmount } = require('./helpers')

const mnt = createMountpoint()

// Two names for one file, as a filesystem with hard links reports them:
// the same inode number from getattr for both.
const INO = 4242
const ops = {
  readdir (file, cb) {
    if (file === '/') return process.nextTick(cb, 0, ['a', 'b'])
    return process.nextTick(cb, Fuse.ENOENT)
  },
  getattr (file, cb) {
    if (file === '/') return process.nextTick(cb, 0, stat({ mode: 'dir', size: 4096 }))
    if (file === '/a' || file === '/b') {
      return process.nextTick(cb, 0, { ...stat({ mode: 'file', size: 0 }), ino: INO, nlink: 2 })
    }
    return process.nextTick(cb, Fuse.ENOENT)
  }
}

function lstat (file) {
  return new Promise((resolve, reject) => {
    fs.lstat(file, { bigint: true }, (err, st) => err ? reject(err) : resolve(st))
  })
}

function mounted (opts, body) {
  return new Promise((resolve, reject) => {
    const fuse = new Fuse(mnt, ops, { force: true, ...opts })
    fuse.mount(err => {
      if (err) return reject(err)
      body().then(
        () => unmount(fuse, resolve),
        bodyErr => unmount(fuse, () => reject(bodyErr))
      )
    })
  })
}

tape('useIno reports the inode number returned by getattr', async function (t) {
  await mounted({ useIno: true }, async () => {
    const a = await lstat(path.join(mnt, 'a'))
    const b = await lstat(path.join(mnt, 'b'))
    t.equal(a.ino, BigInt(INO), 'st_ino is the getattr ino')
    t.equal(b.ino, a.ino, 'both names stat as one inode')
  })
})

tape('without useIno libfuse assigns its own inode numbers', async function (t) {
  await mounted({}, async () => {
    const a = await lstat(path.join(mnt, 'a'))
    const b = await lstat(path.join(mnt, 'b'))
    t.notEqual(a.ino, b.ino, 'each name gets its own node id')
  })
})
