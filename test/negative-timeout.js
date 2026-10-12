const fs = require('fs')
const path = require('path')
const tape = require('tape')

const Fuse = require('../')
const createMountpoint = require('./fixtures/mnt')
const stat = require('./fixtures/stat')
const { unmount } = require('./helpers')

const mnt = createMountpoint()

// A path that does not exist until the test creates it. Counts how often
// the kernel asked, so a cached failed lookup shows up as a missing call.
function lateFile () {
  const state = { exists: false, lookups: 0 }
  state.ops = {
    getattr (file, cb) {
      if (file === '/') return process.nextTick(cb, 0, stat({ mode: 'dir', size: 4096 }))
      if (file === '/late') {
        state.lookups++
        if (state.exists) return process.nextTick(cb, 0, stat({ mode: 'file', size: 0 }))
      }
      return process.nextTick(cb, Fuse.ENOENT)
    }
  }
  return state
}

function exists (file) {
  return new Promise(resolve => fs.stat(file, err => resolve(!err)))
}

function mounted (opts, state, body) {
  return new Promise((resolve, reject) => {
    const fuse = new Fuse(mnt, state.ops, { force: true, ...opts })
    fuse.mount(err => {
      if (err) return reject(err)
      body().then(
        () => unmount(fuse, resolve),
        bodyErr => unmount(fuse, () => reject(bodyErr))
      )
    })
  })
}

tape('negativeTimeout caches a failed lookup in the kernel', async function (t) {
  if (process.platform !== 'linux') {
    t.skip('negative lookup caching is asserted on Linux only')
    return
  }
  const state = lateFile()
  await mounted({ negativeTimeout: 60 }, state, async () => {
    t.notOk(await exists(path.join(mnt, 'late')), 'the first lookup fails')
    state.exists = true
    t.notOk(await exists(path.join(mnt, 'late')), 'the failure is served from the kernel cache')
    t.equal(state.lookups, 1, 'the daemon saw one lookup')
  })
})

tape('negativeTimeout of 0 asks the daemon again', async function (t) {
  if (process.platform !== 'linux') {
    t.skip('negative lookup caching is asserted on Linux only')
    return
  }
  const state = lateFile()
  await mounted({ negativeTimeout: 0 }, state, async () => {
    t.notOk(await exists(path.join(mnt, 'late')), 'the first lookup fails')
    state.exists = true
    t.ok(await exists(path.join(mnt, 'late')), 'the next lookup reaches the daemon')
    t.equal(state.lookups, 2, 'the daemon saw both lookups')
  })
})
