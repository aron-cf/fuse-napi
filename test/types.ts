import Fuse = require('../')

const mountpoint = '/tmp/fuse-napi-types'

new Fuse(mountpoint, {
  init (cb) {
    cb(0)
  },
  readdir (path, cb) {
    void path
    cb(0, [])
  },
  create (path, mode, cb) {
    void path
    void mode
    cb(0, 1n)
  }
})

const invalidationFuse = new Fuse(mountpoint, {})
invalidationFuse.invalidateEntry('/file', err => {
  if (err) throw err
})

new Fuse(mountpoint, {
  initWithConfig (connection, cb) {
    const maxRead: number = connection.maxRead
    void maxRead
    cb(0, {
      maxWrite: connection.maxWrite,
      want: connection.capable,
      asyncRead: false
    })
  },
  readdirPaged (path, fd, offset, cb) {
    void path
    void fd
    void offset
    cb(0, ['entry'], [], [1n])
  },
  createWithFlags (path, mode, flags, cb) {
    void path
    void mode
    void flags
    cb(0, {
      fd: 1n,
      directIO: true,
      keepCache: false,
      nonseekable: false
    })
  },
  utimensWithTimespec (path, atime, mtime, cb) {
    void path
    const seconds: Fuse.Int64 = atime.seconds
    const nanoseconds: number = mtime.nanoseconds
    void seconds
    void nanoseconds
    cb(0)
  },
  readBuffer (path, fd, length, position, cb) {
    void path
    void fd
    void length
    void position
    cb(0, Buffer.from('data'))
  },
  ioctl (path, fd, command, argument, flags, data, cb) {
    void path
    void fd
    void command
    void argument
    void flags
    cb(0, data)
  },
  lock (path, fd, command, lock, cb) {
    void path
    void fd
    void command
    cb(0, { ...lock, pid: 0 })
  },
  chownWithHandle (path, fd, uid, gid, cb) {
    void path
    void fd
    void uid
    void gid
    cb(0)
  },
  chmodWithHandle (path, fd, mode, cb) {
    void path
    void fd
    void mode
    cb(0)
  },
  renameWithFlags (source, destination, flags, cb) {
    void source
    void destination
    void flags
    cb(0)
  },
  pollWithHandle (path, fd, handle, cb) {
    void path
    void fd
    if (handle) {
      const notified: boolean = handle.notify()
      const closed: boolean = handle.close()
      void notified
      void closed
    }
    cb(0, 0)
  }
}, {
  maxConcurrency: 4,
  maxRead: 262144,
  useIno: true,
  nullPathOk: true,
  timeout: { default: 1000, readBuffer: 2000 }
})

new Fuse(mountpoint, {
  initWithConfig (connection, cb) {
    cb(0, {
      // @ts-expect-error maxRead can only be configured as a mount option
      maxRead: connection.maxRead
    })
  }
})

// @ts-expect-error init and initWithConfig are mutually exclusive
const invalidInit: Fuse.OPERATIONS = {
  init (cb) {
    cb(0)
  },
  initWithConfig (connection, cb) {
    void connection
    cb(0)
  }
}

// @ts-expect-error readdir and readdirPaged are mutually exclusive
const invalidReaddir: Fuse.OPERATIONS = {
  readdir (path, cb) {
    void path
    cb(0, [])
  },
  readdirPaged (path, fd, offset, cb) {
    void path
    void fd
    void offset
    cb(0, [], [], [])
  }
}

// @ts-expect-error create and createWithFlags are mutually exclusive
const invalidCreate: Fuse.OPERATIONS = {
  create (path, mode, cb) {
    void path
    void mode
    cb(0, 1)
  },
  createWithFlags (path, mode, flags, cb) {
    void path
    void mode
    void flags
    cb(0, 1)
  }
}

// @ts-expect-error read and readBuffer are mutually exclusive
const invalidRead: Fuse.OPERATIONS = {
  read (path, fd, buffer, length, position, cb) {
    cb(0)
  },
  readBuffer (path, fd, length, position, cb) {
    cb(0, Buffer.alloc(0))
  }
}

// @ts-expect-error utimens variants are mutually exclusive
const invalidUtimens: Fuse.OPERATIONS = {
  utimens (path, atime, mtime, cb) {
    cb(0)
  },
  utimensWithTimespec (path, atime, mtime, cb) {
    cb(0)
  }
}

// @ts-expect-error chown variants are mutually exclusive
const invalidChown: Fuse.OPERATIONS = {
  chown (path, uid, gid, cb) {
    cb(0)
  },
  chownWithHandle (path, fd, uid, gid, cb) {
    cb(0)
  }
}

// @ts-expect-error chmod variants are mutually exclusive
const invalidChmod: Fuse.OPERATIONS = {
  chmod (path, mode, cb) {
    cb(0)
  },
  chmodWithHandle (path, fd, mode, cb) {
    cb(0)
  }
}

// @ts-expect-error rename variants are mutually exclusive
const invalidRename: Fuse.OPERATIONS = {
  rename (source, destination, cb) {
    cb(0)
  },
  renameWithFlags (source, destination, flags, cb) {
    cb(0)
  }
}

// @ts-expect-error poll variants are mutually exclusive
const invalidPoll: Fuse.OPERATIONS = {
  poll (path, fd, cb) {
    cb(0, 0)
  },
  pollWithHandle (path, fd, handle, cb) {
    cb(0, 0)
  }
}

const instance = new Fuse(mountpoint)
const nativeOptionAliases: Fuse.OPTIONS = {
  allow_other: true,
  allow_root: false,
  auto_unmount: true,
  default_permissions: true,
  max_read: 1024,
  kernel_cache: false,
  auto_cache: true,
  direct_io: false,
  entry_timeout: 1,
  attr_timeout: 1,
  ac_attr_timeout: 1,
  nonempty: false,
  nopath: true
}
Fuse.validateOptions(nativeOptionAliases)
new Fuse(mountpoint, {}, nativeOptionAliases)
const invalidInternalOption: Fuse.OPTIONS = {
  // @ts-expect-error user_id is managed internally by FUSE 3
  user_id: 501
}
const invalidRemovedOption: Fuse.OPTIONS = {
  // @ts-expect-error nonempty: true was removed by FUSE 3
  nonempty: true
}
const context: Readonly<Fuse.RequestContext> | null = instance.context()
const now: number = Fuse.UTIME_NOW
void context
void now

void invalidInit
void invalidReaddir
void invalidCreate
void invalidRead
void invalidUtimens
void invalidChown
void invalidChmod
void invalidRename
void invalidPoll
void invalidInternalOption
void invalidRemovedOption
